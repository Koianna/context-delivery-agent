#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { writeInlineMaterials } from "../scripts/gateway/inline-materials.js";
import { PROJECT_ROOT, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";
import { registerMaterials } from "../scripts/register-materials.js";
import { safeProjectSlug } from "../scripts/lib/project-paths.js";

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
const taskSourceMarkdown = fs.readdirSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/source-materials", taskId)).filter((name) => /\.md$/i.test(name));
const results = [
  check("WORKSPACE-01", response.provider.id === "workspace", "未指定案例时使用通用项目工作区 Provider"),
  check("WORKSPACE-02", response.state.id === "CONTEXT_TASK_COMPLETED" && response.status === "COMPLETED", "通用材料整理完成，不进入 PRD 生成"),
  check("WORKSPACE-03", materialReportContent.includes("手机号不用了") && materialReportContent.includes("USER_FEEDBACK"), "保留用户原话并分类为用户反馈"),
  check("WORKSPACE-04", contextReportContent.includes("具体诉求") && !contextReportContent.includes("修改手机号"), "将可能诉求保留为待确认问题，不擅自升级为明确需求"),
  check("WORKSPACE-04A", response.execution_status === "COMPLETED" && structuredMaterialPath?.includes("context-workspace/workspace/projects/account-settings/materials/structured-materials") === true && structuredMaterialContent.includes("手机号不用了"), "Runtime 将可阅读整理稿发布到可版本管理的项目工作区"),
  check("WORKSPACE-04B", !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/用户反馈.txt")) && response.artifacts.some((item) => item.label === "材料登记清单"), "原文只保留在 source-materials 中，不在 drafts 根目录生成重复副本"),
  check("WORKSPACE-04C", repeatRegistration.status === "UNCHANGED" && manifest.records.length === 1 && manifest.records[0]?.draft_ref.includes(`/source-materials/${taskId}/`), "相同材料重复登记幂等，清单直接引用唯一原文"),
  check("WORKSPACE-04D", manifest.ingestions.some((item) => item.task_id === taskId && item.materials.some((material) => material.original_name === "用户反馈.txt")) && !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/drafts/account-settings/source-materials", taskId, "ingest-manifest.json")), "接入元数据和登记记录合并到统一材料清单，且不再生成旧接入清单"),
  check("WORKSPACE-04G", taskSourceMarkdown.length === 1 && taskSourceMarkdown[0] === "materials.md", "本地路径材料也统一保存为单个任务级 Markdown 原文包"),
  check("WORKSPACE-05", state?.project_id === "account-settings" && response.artifacts.some((item) => item.ref.includes("account-settings")), "产物按项目隔离并带有项目标识"),
  check("WORKSPACE-04F", !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/workspace/plans")) && !fs.existsSync(path.join(PROJECT_ROOT, "context-workspace/workspace/snapshots")), "普通材料整理不会提前创建变更计划和快照目录"),
];
results.push(check(
  "WORKSPACE-04E",
  ["manual-numbered-eval", "workspace-numbered-eval"].every((projectId) => {
    try { safeProjectSlug(projectId); return false; } catch { return true; }
  }),
  "历史测试项目标识被保留，不能创建同名项目目录",
));

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
  check("WORKSPACE-07", !fs.existsSync(contextRoot), "CP-C01 前不创建项目稳定 Context 目录"),
  check("WORKSPACE-08", typeof contextCandidate === "string" && contextCandidate.includes("runtime/provider-output"), "候选内容保存在可追踪的工作区产物中"),
);
const contextApplied = await contextAgent.handleMessage("确认全部", { taskId: "workspace-confirmed-context-demo", projectId: "account-settings", debug: true });
const contextIndexPath = path.join(contextRoot, "INDEX.md");
results.push(
  check("WORKSPACE-09", contextApplied.state.id === "CONTEXT_TASK_COMPLETED" && contextApplied.status === "COMPLETED", "CP-C01 后完成 Context 维护任务"),
  check("WORKSPACE-10", fs.existsSync(contextIndexPath) && fs.readFileSync(contextIndexPath, "utf-8").includes("产品现状候选") && fs.readdirSync(path.join(contextRoot, "product")).some((item) => item.endsWith(".md")) && !["users", "business-rules", "glossary"].some((group) => fs.existsSync(path.join(contextRoot, group))), "批准后仅创建实际使用的稳定 Context 分类目录并更新项目索引"),
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
  { taskId: "workspace-format-meeting-demo", projectId: "workspace-format-eval", materialPath: numberedSourceDir, debug: true },
);
const numberedArtifact = numberedResponse.artifacts.find((item) => item.label === "结构化整理稿");
const numberedPath = numberedArtifact ? repoRefToPath(numberedArtifact.ref, PROJECT_ROOT) : null;
const numberedContent = numberedPath && fs.existsSync(numberedPath) ? fs.readFileSync(numberedPath, "utf-8") : "";
results.push(
  check("WORKSPACE-15", ["CONTEXT_TASK_COMPLETED", "WAITING_CONTEXT_CONFIRM"].includes(numberedResponse.state.id) && ["COMPLETED", "WAITING_CONFIRMATION"].includes(numberedResponse.status), "有序会议记录完成结构化整理并遵守 Context 确认门槛"),
  check("WORKSPACE-16", numberedContent.includes("搜索召回阶段增加同义词扩展：品牌别名、品类俗称、常见错别字") && numberedContent.includes("用户/客服反馈：运营团队要求保留手动干预搜索结果排序的能力") && numberedContent.includes("用户/客服反馈：决定将搜索日志保留期从 30 天延长到 90 天"), "整理稿去除正文有序列表序号且保留完整内容"),
  check("WORKSPACE-17", !/[-*] .*：\s*\d+[.)、]/u.test(numberedContent) && !numberedContent.includes("2. 搜") && !numberedContent.includes("3. 运营") && !numberedContent.includes("4. 决定"), "字段值和分类条目不再混入有序列表序号"),
);

clear();
const feedbackTaskId = "workspace-feedback-format-demo";
const feedbackProjectId = "workspace-feedback-format-eval";
const feedbackGoal = "帮我整理一下这份用户反馈";
const feedbackSourceDir = writeInlineMaterials([
  { name: "反馈1", content: "用户 ID：u_8912\n时间：2026-07-15\n内容：搜 \"夏天连衣裙\" 出来一堆冬装，排序完全不看季节，能不能改改？", source_type: "USER_FEEDBACK", source_owner: "u_8912", source_time: "2026-07-15" },
  { name: "反馈2_无线鼠标静音.md", content: "用户 ID：u_4521\n时间：2026-07-22\n内容：我搜的是 \"无线鼠标 静音\"，第一个结果是有线鼠标，第二个是机械键盘，无语了。", source_type: "USER_FEEDBACK", source_owner: "u_4521", source_time: "2026-07-22" },
  { name: "反馈3", content: "用户 ID：u_6733\n时间：2026-07-28\n内容：搜索框输入拼音 \"pingguo\" 希望能识别出 \"苹果\"，我现在每次都要切换到中文输入法再打一遍。", source_type: "USER_FEEDBACK", source_owner: "u_6733", source_time: "2026-07-28" },
  { name: "反馈4", content: "用户 ID：u_9012\n时间：2026-07-30\n内容：搜索结果加载太慢了，搜一个词要等 5 秒以上，跟竞品比完全不行。", source_type: "USER_FEEDBACK", source_owner: "u_9012", source_time: "2026-07-30" },
], feedbackProjectId, feedbackTaskId, feedbackGoal);
const feedbackResponse = await new AgentOrchestrator(new WorkspaceProvider()).handleMessage(feedbackGoal, {
  taskId: feedbackTaskId,
  projectId: feedbackProjectId,
  materialPath: feedbackSourceDir,
  debug: true,
});
const feedbackArtifact = feedbackResponse.artifacts.find((item) => item.label === "结构化整理稿");
const feedbackArtifactPath = feedbackArtifact ? repoRefToPath(feedbackArtifact.ref, PROJECT_ROOT) : null;
const feedbackContent = feedbackArtifactPath && fs.existsSync(feedbackArtifactPath) ? fs.readFileSync(feedbackArtifactPath, "utf-8") : "";
const feedbackBundlePath = path.join(feedbackSourceDir, "materials.md");
const feedbackSourceHref = `../../../../../drafts/${feedbackProjectId}/source-materials/${feedbackTaskId}/materials.md`;
const resolvedFeedbackSource = feedbackArtifactPath ? path.resolve(path.dirname(feedbackArtifactPath), feedbackSourceHref) : null;
results.push(
  check("WORKSPACE-18", ["u_8912", "u_4521", "u_6733", "u_9012"].every((id) => feedbackContent.includes(`用户 ID：${id}：`)) && feedbackContent.includes("用户 ID：u_6733：搜索框输入拼音 \"pingguo\" 希望能识别出 \"苹果\""), "用户反馈按完整记录输出，用户 ID 与反馈正文保持在同一行"),
  check("WORKSPACE-19", !feedbackContent.includes("用户/客服反馈：用户 ID") && !feedbackContent.includes("方案建议：内容：搜") && !feedbackContent.includes("## 背景与事实\n\n- 时间："), "用户反馈字段不会被拆散或误分到背景和方案"),
  check("WORKSPACE-20", feedbackContent.includes(`[反馈1：夏天连衣裙](${feedbackSourceHref}#material-1)`) && feedbackContent.includes(`[反馈2：无线鼠标 静音](${feedbackSourceHref}#material-2)`) && feedbackContent.includes("用户 ID：u_8912；日期：2026-07-15；类型：用户反馈") && resolvedFeedbackSource === feedbackBundlePath && fs.existsSync(resolvedFeedbackSource) && !feedbackContent.includes("src-") && !feedbackContent.includes("](repo://"), "来源区名称不随外部简写漂移，且标准 Markdown 相对链接能解析到原文文件"),
  check("WORKSPACE-21", fs.existsSync(feedbackBundlePath) && [1, 2, 3, 4].every((index) => fs.readFileSync(feedbackBundlePath, "utf-8").includes(`<a id=\"material-${index}\"></a>`)), "任务级原文包为每条逻辑材料提供稳定定位锚点"),
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
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/projects/workspace-format-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/workspace-paragraph-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/workspace-format-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/drafts/workspace-feedback-format-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-phone-feedback-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-confirmed-context-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-paragraph-meeting-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-format-meeting-demo"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/projects/workspace-feedback-format-eval"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs/workspace-feedback-format-demo"), { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
