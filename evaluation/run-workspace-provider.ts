#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { PROJECT_ROOT, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";

const taskId = "workspace-phone-feedback-demo";
const sourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-eval-materials");
const sourcePath = path.join(sourceDir, "用户反馈.txt");
clear();
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(sourcePath, "用户原话：手机号不用了。\n", "utf-8");

const agent = new AgentOrchestrator(new WorkspaceProvider());
const response = agent.handleMessage(
  "请收集整理这条用户反馈，不要直接写成修改手机号需求，也不要写 PRD",
  { taskId, projectId: "account-settings", materialPath: sourceDir, debug: true }
);
const state = readTaskState();
const materialReport = response.artifacts.find((item) => item.label === "材料分析报告");
const contextReport = response.artifacts.find((item) => item.label === "Context 分析报告");
const structuredMaterial = response.artifacts.find((item) => item.label === "结构化整理稿");
const materialReportPath = materialReport ? repoRefToPath(materialReport.ref, PROJECT_ROOT) : null;
const contextReportPath = contextReport ? repoRefToPath(contextReport.ref, PROJECT_ROOT) : null;
const materialReportContent = materialReportPath && fs.existsSync(materialReportPath) ? fs.readFileSync(materialReportPath, "utf-8") : "";
const contextReportContent = contextReportPath && fs.existsSync(contextReportPath) ? fs.readFileSync(contextReportPath, "utf-8") : "";
const structuredMaterialPath = structuredMaterial ? repoRefToPath(structuredMaterial.ref, PROJECT_ROOT) : null;
const structuredMaterialContent = structuredMaterialPath && fs.existsSync(structuredMaterialPath) ? fs.readFileSync(structuredMaterialPath, "utf-8") : "";
const results = [
  check("WORKSPACE-01", response.provider.id === "workspace", "未指定案例时使用通用项目工作区 Provider"),
  check("WORKSPACE-02", response.state.id === "CONTEXT_TASK_COMPLETED" && response.status === "COMPLETED", "通用材料整理完成，不进入 PRD 生成"),
  check("WORKSPACE-03", materialReportContent.includes("手机号不用了") && materialReportContent.includes("USER_FEEDBACK"), "保留用户原话并分类为用户反馈"),
  check("WORKSPACE-04", contextReportContent.includes("具体诉求") && !contextReportContent.includes("修改手机号"), "将可能诉求保留为待确认问题，不擅自升级为明确需求"),
  check("WORKSPACE-04A", response.execution_status === "COMPLETED" && structuredMaterialPath?.includes("context-workspace/workspace/agent-runs") === true && structuredMaterialContent.includes("手机号不用了"), "Runtime 生成可阅读整理稿并放入 context-workspace，保留原始反馈"),
  check("WORKSPACE-05", state?.project_id === "account-settings" && response.artifacts.some((item) => item.ref.includes("account-settings")), "产物按项目隔离并带有项目标识"),
];

clear();
const confirmedSourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-confirmed-materials");
const confirmedSourcePath = path.join(confirmedSourceDir, "产品现状.md");
fs.mkdirSync(confirmedSourceDir, { recursive: true });
fs.writeFileSync(confirmedSourcePath, "---\nsource_type: PRODUCT_DOC\nsource_owner: 产品团队\nsource_time: 2026-08-05T10:00:00+08:00\n---\n\n# 当前产品现状\n\n当前产品支持手机号绑定和登录验证。\n", "utf-8");
const contextAgent = new AgentOrchestrator(new WorkspaceProvider());
const contextPending = contextAgent.handleMessage(
  "整理并沉淀这份产品现状，先让我确认 Context 更新，不要写 PRD",
  { taskId: "workspace-confirmed-context-demo", projectId: "account-settings", materialPath: confirmedSourceDir, debug: true }
);
const contextRef = "repo://context-workspace/projects/account-settings/context/product/item-1-src";
const contextCandidate = contextPending.confirmation?.items[0]?.content_ref;
const contextRoot = path.join(PROJECT_ROOT, "context-workspace/projects/account-settings/context");
results.push(
  check("WORKSPACE-06", contextPending.state.id === "WAITING_CONTEXT_CONFIRM" && contextPending.confirmation?.items.length === 1, "明确产品现状材料生成稳定 Context 候选并停在 CP-C01"),
  check("WORKSPACE-07", !fs.existsSync(contextRoot) || !fs.readdirSync(contextRoot, { recursive: true }).some((item) => String(item).endsWith(".md")), "CP-C01 前不写入项目稳定 Context"),
  check("WORKSPACE-08", typeof contextCandidate === "string" && contextCandidate.includes("runtime/provider-output"), "候选内容保存在可追踪的工作区产物中"),
);
const contextApplied = contextAgent.handleMessage("确认全部", { taskId: "workspace-confirmed-context-demo", projectId: "account-settings", debug: true });
const contextIndexPath = path.join(contextRoot, "INDEX.md");
results.push(
  check("WORKSPACE-09", contextApplied.state.id === "CONTEXT_TASK_COMPLETED" && contextApplied.status === "COMPLETED", "CP-C01 后完成 Context 维护任务"),
  check("WORKSPACE-10", fs.existsSync(contextIndexPath) && fs.readFileSync(contextIndexPath, "utf-8").includes("产品现状候选") && fs.readdirSync(path.join(contextRoot, "product")).some((item) => item.endsWith(".md")), "批准后创建稳定 Context 并更新项目索引"),
  check("WORKSPACE-11", contextApplied.execution_status === "COMPLETED" && contextApplied.artifacts.some((item) => item.label === "结构化整理稿" && item.ref.includes("context-workspace/")), "确认后仍返回 Runtime 生成的整理稿"),
);
const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ evaluation_id: "workspace-provider-generic-material", summary: { total: results.length, passed, failed: results.length - passed }, results }, null, 2));
clear();
if (passed !== results.length) process.exit(1);

function check(caseId: string, passed: boolean, detail: string) { return { case_id: caseId, passed, detail }; }
function clear() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-eval-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-confirmed-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/projects/account-settings"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-phone-feedback-demo"), { recursive: true, force: true });
}
