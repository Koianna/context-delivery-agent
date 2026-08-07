#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import { parseFrontmatter, readJson, renderFrontmatter, repoRefToPath, writeTextAtomic } from "../scripts/lib/repository.js";
import { updateIndex } from "../scripts/update-index.js";
import type { ContextAnalysisOutput } from "../scripts/lib/context-types.js";
import { isolateRuntime } from "./runtime-isolation.js";

isolateRuntime(PROJECT_ROOT);

interface Result { case_id: string; passed: boolean; detail: string }

const projectId = "context-section-move-eval";
const taskId = "context-section-move-task";
const archiveTaskId = "context-file-archive-task";
const targetRef = `repo://context-workspace/context/${projectId}/business-rules/search-rules.md`;
const targetPath = repoRefToPath(targetRef, PROJECT_ROOT);
const originalBody = [
  "# 搜索优化需求讨论会",
  "",
  "## 会议结论",
  "",
  "1. 搜索召回阶段增加同义词扩展。",
  "2. 保留手动干预搜索结果排序的能力。",
  "",
  "## 待确认事项",
  "",
  "- 同义词库的初始数据来源和审核流程未定",
  "- 手动干预排序是否需要审批流",
  "- 搜索结果页是否需要新增 \"您是不是想找\" 模块",
].join("\n");
const message = `将 context-workspace/context/${projectId}/business-rules/search-rules.md 中 ## 待确认事项 从稳定 Context 中移出，放到 workspace 中；## 会议结论保留在稳定 Context 中。`;

async function main() {
  const results: Result[] = [];
  clear();
  try {
    writeTextAtomic(targetPath, renderFrontmatter({
      id: "search-rules",
      version: "0.1.0",
      status: "active",
      source_refs: ["src-search-meeting"],
      confirmed_by: "user",
      confirmed_at: "2026-08-07T08:00:00+08:00",
    }, originalBody));
    updateIndex(PROJECT_ROOT, "2026-08-07", projectId);

    const agent = new AgentOrchestrator(new WorkspaceProvider());
    const pending = await agent.handleMessage(message, { taskId, projectId, debug: true });
    const proposal = pending.confirmation?.items[0];
    const workspaceRef = typeof proposal?.workspace_ref === "string" ? proposal.workspace_ref : null;
    const candidateRef = typeof proposal?.content_ref === "string" ? proposal.content_ref : null;
    const reportPath = repoRefToPath(`repo://context-workspace/workspace/agent-runs/${taskId}/reports/context-analysis.json`, PROJECT_ROOT);
    if (!fs.existsSync(reportPath)) throw new Error(`局部更新未生成分析报告: ${JSON.stringify(pending)}`);
    const report = readJson<ContextAnalysisOutput>(reportPath);
    const unchangedBeforeConfirm = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));

    results.push(
      check("SECTION-MOVE-01", pending.state.id === "WAITING_CONTEXT_CONFIRM" && pending.status === "WAITING_CONFIRMATION", "局部移出请求直接进入 CP-C01，不要求整文件归档"),
      check("SECTION-MOVE-02", pending.confirmation?.items.length === 1 && proposal?.action === "UPDATE_CONTEXT" && proposal.target_ref === targetRef && !report.update_proposals.some((item) => item.target_ref?.endsWith("/INDEX.md")), "只为目标业务文件生成一个 UPDATE_CONTEXT 提案，INDEX 不进入确认项"),
      check("SECTION-MOVE-03", unchangedBeforeConfirm.metadata.version === "0.1.0" && unchangedBeforeConfirm.body.includes("## 待确认事项"), "CP-C01 前稳定 Context 保持原版本和原正文"),
      check("SECTION-MOVE-04", workspaceRef !== null && fs.existsSync(repoRefToPath(workspaceRef, PROJECT_ROOT)) && fs.readFileSync(repoRefToPath(workspaceRef, PROJECT_ROOT), "utf-8").includes("手动干预排序是否需要审批流"), "被移出的章节先保存为可追溯的 workspace 待确认内容"),
      check("SECTION-MOVE-05", candidateRef !== null && fs.existsSync(repoRefToPath(candidateRef, PROJECT_ROOT)) && !parseFrontmatter(fs.readFileSync(repoRefToPath(candidateRef, PROJECT_ROOT), "utf-8")).body.includes("## 待确认事项"), "稳定 Context 候选只删除指定章节"),
    );

    const applied = await agent.handleMessage(`确认更新 ${String(proposal?.proposal_id)}`, { taskId, projectId, debug: true });
    const updated = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
    const index = fs.readFileSync(path.join(PROJECT_ROOT, "context-workspace/context", projectId, "INDEX.md"), "utf-8");
    results.push(
      check("SECTION-MOVE-06", applied.state.id === "CONTEXT_TASK_COMPLETED" && applied.status === "COMPLETED", "批准局部更新后任务正常完成"),
      check("SECTION-MOVE-07", updated.metadata.version === "0.1.1" && updated.metadata.status === "active" && updated.body.includes(originalBody.split("## 待确认事项")[0].trim()) && !updated.body.includes("## 待确认事项"), "稳定文件仅移出指定章节，逐字保留会议结论并递增版本"),
      check("SECTION-MOVE-08", index.includes("business-rules/search-rules.md") && index.includes("active") && applied.artifacts.some((item) => item.ref === workspaceRef), "稳定索引继续保留原文件，完成响应返回 workspace 内容"),
    );

    clear();
    writeTextAtomic(targetPath, renderFrontmatter({
      id: "search-rules",
      version: "0.1.0",
      status: "active",
      source_refs: ["src-search-meeting"],
      confirmed_by: "user",
      confirmed_at: "2026-08-07T08:00:00+08:00",
    }, originalBody));
    updateIndex(PROJECT_ROOT, "2026-08-07", projectId);
    const archiveAgent = new AgentOrchestrator(new WorkspaceProvider());
    const archivePending = await archiveAgent.handleMessage(`请撤销并归档 ${targetRef} 整个文件`, { taskId: archiveTaskId, projectId, debug: true });
    const archiveProposal = archivePending.confirmation?.items[0];
    results.push(
      check("SECTION-MOVE-09", archivePending.confirmation?.items.length === 1 && archiveProposal?.action === "ARCHIVE" && archiveProposal.target_ref === targetRef, "明确整文件撤销仍生成单个 ARCHIVE 提案，不包含 INDEX"),
    );
    const archivedResponse = await archiveAgent.handleMessage(`确认撤销 ${String(archiveProposal?.proposal_id)}`, { taskId: archiveTaskId, projectId, debug: true });
    const archived = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
    results.push(
      check("SECTION-MOVE-10", archivedResponse.status === "COMPLETED" && archived.metadata.status === "archived" && archived.metadata.version === "0.1.1", "整文件撤销继续通过 CP-C01 归档并递增版本"),
    );
  } finally {
    clear();
  }

  const passed = results.filter((item) => item.passed).length;
  console.log(JSON.stringify({
    evaluation_id: "context-section-move",
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  }, null, 2));
  if (passed !== results.length) process.exit(1);
}

function check(caseId: string, passed: boolean, detail: string): Result {
  return { case_id: caseId, passed, detail };
}

function clear() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  for (const target of [
    path.join(PROJECT_ROOT, "context-workspace/context", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", archiveTaskId),
    path.join(PROJECT_ROOT, "runtime/provider-output"),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error) => {
  clear();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
