#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { PROJECT_ROOT, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";
import { registerMaterials } from "../scripts/register-materials.js";

async function main() {
const taskId = "workspace-phone-feedback-demo";
const sourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-eval-materials");
const sourcePath = path.join(sourceDir, "用户反馈.txt");
clear();
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(sourcePath, "用户原话：手机号不用了。\n", "utf-8");

const agent = new AgentOrchestrator(new WorkspaceProvider());
const response = await agent.handleMessage(
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
const repeatRegistration = registerMaterials(path.join(PROJECT_ROOT, "runtime/provider-output", taskId, "material-ingest.input.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/material-manifest.json"), "utf-8")) as { records: Array<{ draft_ref: string }>; ingestions: Array<{ task_id: string; materials: Array<{ original_name: string }> }> };
const results = [
  check("WORKSPACE-01", response.provider.id === "workspace", "未指定案例时使用通用项目工作区 Provider"),
  check("WORKSPACE-02", response.state.id === "CONTEXT_TASK_COMPLETED" && response.status === "COMPLETED", "通用材料整理完成，不进入 PRD 生成"),
  check("WORKSPACE-03", materialReportContent.includes("手机号不用了") && materialReportContent.includes("USER_FEEDBACK"), "保留用户原话并分类为用户反馈"),
  check("WORKSPACE-04", contextReportContent.includes("具体诉求") && !contextReportContent.includes("修改手机号"), "将可能诉求保留为待确认问题，不擅自升级为明确需求"),
  check("WORKSPACE-04A", response.execution_status === "COMPLETED" && structuredMaterialPath?.includes("context-workspace/workspace/projects/account-settings/materials/structured-materials") === true && structuredMaterialContent.includes("手机号不用了"), "Runtime 将可阅读整理稿发布到可版本管理的项目工作区"),
  check("WORKSPACE-04B", !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/用户反馈.txt")) && response.artifacts.some((item) => item.label === "材料登记清单"), "原文只保留在 source-materials 中，不在 drafts 根目录生成重复副本"),
  check("WORKSPACE-04C", repeatRegistration.status === "UNCHANGED" && manifest.records.length === 1 && manifest.records[0]?.draft_ref.includes(`/source-materials/${taskId}/`), "相同材料重复登记幂等，清单直接引用唯一原文"),
  check("WORKSPACE-04D", manifest.ingestions.some((item) => item.task_id === taskId && item.materials.some((material) => material.original_name === "用户反馈.txt")) && !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/source-materials", taskId, "ingest-manifest.json")), "接入元数据和登记记录合并到统一材料清单，且不再生成旧接入清单"),
  check("WORKSPACE-05", state?.project_id === "account-settings" && response.artifacts.some((item) => item.ref.includes("account-settings")), "产物按项目隔离并带有项目标识"),
];

clear();
const confirmedSourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-confirmed-materials");
const confirmedSourcePath = path.join(confirmedSourceDir, "产品现状.md");
fs.mkdirSync(confirmedSourceDir, { recursive: true });
fs.writeFileSync(confirmedSourcePath, "---\nsource_type: PRODUCT_DOC\nsource_owner: 产品团队\nsource_time: 2026-08-05T10:00:00+08:00\n---\n\n# 当前产品现状\n\n当前产品支持手机号绑定和登录验证。\n", "utf-8");
const contextAgent = new AgentOrchestrator(new WorkspaceProvider());
const contextPending = await contextAgent.handleMessage(
  "整理并沉淀这份产品现状，先让我确认 Context 更新，不要写 PRD",
  { taskId: "workspace-confirmed-context-demo", projectId: "account-settings", materialPath: confirmedSourceDir, debug: true }
);
const contextRef = "repo://context-workspace/context/account-settings/product/item-1-src";
const contextCandidate = contextPending.confirmation?.items[0]?.content_ref;
const contextRoot = path.join(PROJECT_ROOT, "context-workspace/context/account-settings");
results.push(
  check("WORKSPACE-06", contextPending.state.id === "WAITING_CONTEXT_CONFIRM" && contextPending.confirmation?.items.length === 1, "明确产品现状材料生成稳定 Context 候选并停在 CP-C01"),
  check("WORKSPACE-07", !fs.existsSync(contextRoot) || !fs.readdirSync(contextRoot, { recursive: true }).some((item) => String(item).endsWith(".md")), "CP-C01 前不写入项目稳定 Context"),
  check("WORKSPACE-08", typeof contextCandidate === "string" && contextCandidate.includes("runtime/provider-output"), "候选内容保存在可追踪的工作区产物中"),
);
const contextApplied = await contextAgent.handleMessage("确认全部", { taskId: "workspace-confirmed-context-demo", projectId: "account-settings", debug: true });
const contextIndexPath = path.join(contextRoot, "INDEX.md");
results.push(
  check("WORKSPACE-09", contextApplied.state.id === "CONTEXT_TASK_COMPLETED" && contextApplied.status === "COMPLETED", "CP-C01 后完成 Context 维护任务"),
  check("WORKSPACE-10", fs.existsSync(contextIndexPath) && fs.readFileSync(contextIndexPath, "utf-8").includes("产品现状候选") && fs.readdirSync(path.join(contextRoot, "product")).some((item) => item.endsWith(".md")), "批准后创建稳定 Context 并更新项目索引"),
  check("WORKSPACE-11", contextApplied.execution_status === "COMPLETED" && contextApplied.artifacts.some((item) => item.label === "结构化整理稿" && item.ref.includes("context-workspace/")), "确认后仍返回 Runtime 生成的整理稿"),
);

clear();
const paragraphSourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-paragraph-materials");
const paragraphSourcePath = path.join(paragraphSourceDir, "会议纪要-无发言人.md");
fs.mkdirSync(paragraphSourceDir, { recursive: true });
fs.writeFileSync(paragraphSourcePath, "决定了：先完成用户反馈归类。建议短期先验证一项可维护规则和结果反馈，不直接扩大到未确认的扩展能力。业务团队提供样本，产品经理下周输出第一期需求草稿。资料导出前需要脱敏并和数据同学确认。", "utf-8");
const paragraphResponse = await new AgentOrchestrator(new WorkspaceProvider()).handleMessage(
  "整理这份会议纪要，不写 PRD",
  { taskId: "workspace-paragraph-meeting-demo", projectId: "workspace-paragraph-eval", materialPath: paragraphSourceDir, debug: true },
);
const paragraphArtifact = paragraphResponse.artifacts.find((item) => item.label === "结构化整理稿");
const paragraphPath = paragraphArtifact ? repoRefToPath(paragraphArtifact.ref, PROJECT_ROOT) : null;
const paragraphContent = paragraphPath && fs.existsSync(paragraphPath) ? fs.readFileSync(paragraphPath, "utf-8") : "";
results.push(
  check("WORKSPACE-12", paragraphResponse.state.id === "CONTEXT_TASK_COMPLETED" && paragraphResponse.status === "COMPLETED", "无发言人格式的会议材料也完成 Context 整理"),
  check("WORKSPACE-13", paragraphPath?.includes("context-workspace/workspace/projects/workspace-paragraph-eval/materials/meeting-notes/workspace-paragraph-meeting-demo.md") === true && paragraphContent.includes("## 归纳摘要") && paragraphContent.includes("## 已确认决策") && paragraphContent.includes("## 行动项与分工"), "无发言人格式生成项目级结构化整理稿"),
  check("WORKSPACE-14", paragraphContent !== fs.readFileSync(paragraphSourcePath, "utf-8") && paragraphContent.includes("归纳摘要") && paragraphContent.includes("原文保留说明"), "整理稿不是原文复制，并包含归纳分类结果"),
);

clear();
const numberedSourceDir = path.join(PROJECT_ROOT, "runtime/workspace-provider-numbered-materials");
const numberedSourcePath = path.join(numberedSourceDir, "搜索优化需求讨论会.md");
fs.mkdirSync(numberedSourceDir, { recursive: true });
fs.writeFileSync(numberedSourcePath, [
  "## 搜索优化需求讨论会",
  "",
  "日期：2026-08-01",
  "参会人：产品经理小陈、搜索研发小李、运营负责人张姐",
  "",
  "### 会议结论",
  "",
  "1. 零结果率居高不下的核心原因是类目匹配规则过于严格。",
  "2. 搜索召回阶段增加同义词扩展：品牌别名、品类俗称、常见错别字。",
  "3. 运营团队要求保留手动干预搜索结果排序的能力，且手动权重覆盖所有算法排序。",
  "4. 决定将搜索日志保留期从 30 天延长到 90 天，用于训练排序模型。",
  "5. 下一版本搜索架构升级暂不纳入本期，本期聚焦规则和排序优化。",
  "",
  "### 待确认事项",
  "",
  "- 同义词库的初始数据来源和审核流程未定",
].join("\n"), "utf-8");
const numberedResponse = await new AgentOrchestrator(new WorkspaceProvider()).handleMessage(
  "整理这份会议记录，不写 PRD",
  { taskId: "workspace-numbered-meeting-demo", projectId: "workspace-numbered-eval", materialPath: numberedSourceDir, debug: true },
);
const numberedArtifact = numberedResponse.artifacts.find((item) => item.label === "结构化整理稿");
const numberedPath = numberedArtifact ? repoRefToPath(numberedArtifact.ref, PROJECT_ROOT) : null;
const numberedContent = numberedPath && fs.existsSync(numberedPath) ? fs.readFileSync(numberedPath, "utf-8") : "";
results.push(
  check("WORKSPACE-15", ["CONTEXT_TASK_COMPLETED", "WAITING_CONTEXT_CONFIRM"].includes(numberedResponse.state.id) && ["COMPLETED", "WAITING_CONFIRMATION"].includes(numberedResponse.status), "有序会议记录完成结构化整理并遵守 Context 确认门槛"),
  check("WORKSPACE-16", numberedContent.includes("搜索召回阶段增加同义词扩展：品牌别名、品类俗称、常见错别字") && numberedContent.includes("用户/客服反馈：运营团队要求保留手动干预搜索结果排序的能力") && numberedContent.includes("用户/客服反馈：决定将搜索日志保留期从 30 天延长到 90 天"), "整理稿去除正文有序列表序号且保留完整内容"),
  check("WORKSPACE-17", !/[-*] .*：\s*\d+[.)、]/u.test(numberedContent) && !numberedContent.includes("2. 搜") && !numberedContent.includes("3. 运营") && !numberedContent.includes("4. 决定"), "字段值和分类条目不再混入有序列表序号"),
);
const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ evaluation_id: "workspace-provider-generic-material", summary: { total: results.length, passed, failed: results.length - passed }, results }, null, 2));
clear();
if (passed !== results.length) process.exit(1);
}

function check(caseId: string, passed: boolean, detail: string) { return { case_id: caseId, passed, detail }; }
function clear() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-eval-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-confirmed-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-paragraph-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/workspace-provider-numbered-materials"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/context/account-settings"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/context/workspace-paragraph-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/projects/account-settings"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/projects/workspace-paragraph-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/projects/workspace-numbered-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/workspace-paragraph-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-phone-feedback-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-confirmed-context-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-paragraph-meeting-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-numbered-meeting-demo"), { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
