#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { PROJECT_ROOT, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";
import { isolateRuntime } from "./runtime-isolation.js";

isolateRuntime(PROJECT_ROOT);

const projectId = "material-reprocess-eval";
const sourceDir = path.join(PROJECT_ROOT, "runtime/material-reprocess-source");
const sourcePath = path.join(sourceDir, "same-material.md");
const taskOne = "material-reprocess-first";
const taskTwo = "material-reprocess-second";
const taskThree = "material-reprocess-third";
const blockedTask = "context-retry-task";
const results: Array<{ case_id: string; passed: boolean; detail: string }> = [];

class FailOnceProvider extends WorkspaceProvider {
  private failed = false;
  override async getContextAssets(materialPath?: string, taskId?: string, taskGoal?: string) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("模拟材料分析中断");
    }
    return await super.getContextAssets(materialPath, taskId, taskGoal);
  }
}

function check(caseId: string, passed: boolean, detail: string) {
  results.push({ case_id: caseId, passed, detail });
}

async function main() {
  clean();
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(sourcePath, "---\nsource_type: USER_FEEDBACK\n---\n\n用户反馈：搜索结果加载较慢。\n", "utf-8");

  const first = new AgentOrchestrator(new WorkspaceProvider());
  const firstResponse = await first.handleMessage("只整理这份材料，不写 PRD", { taskId: taskOne, projectId, materialPath: sourcePath });
  check("REPROCESS-01", firstResponse.state.id === "CONTEXT_TASK_COMPLETED", "首次整理正常完成");

  const second = new AgentOrchestrator(new WorkspaceProvider());
  const duplicateResponse = await second.handleMessage("请整理这份材料", { taskId: taskTwo, projectId, materialPath: sourcePath });
  check("REPROCESS-02", duplicateResponse.state.id === "WAITING_MATERIAL_REPROCESS_CONFIRM" && duplicateResponse.confirmation?.items.length === 1, "同一项目再次提交相同材料时先询问是否重新整理");
  check("REPROCESS-03", duplicateResponse.message.includes("已经在当前项目中整理过") && duplicateResponse.next_steps.some((step: string) => step.includes("覆盖")), "提示已存在材料并明确覆盖选择");

  const keepResponse = await second.handleMessage("保留已有整理稿", { taskId: taskTwo, projectId });
  check("REPROCESS-04", keepResponse.state.id === "CONTEXT_TASK_COMPLETED" && keepResponse.message.includes("没有重新分析或覆盖"), "拒绝重做时保留原整理稿并结束任务");

  const third = new AgentOrchestrator(new WorkspaceProvider());
  const approvePrompt = await third.handleMessage("请再次整理这份材料", { taskId: taskThree, projectId, materialPath: sourcePath });
  const approved = await third.handleMessage("确认重新整理并覆盖", { taskId: taskThree, projectId, materialPath: sourcePath });
  check("REPROCESS-05", approvePrompt.state.id === "WAITING_MATERIAL_REPROCESS_CONFIRM" && approved.state.id === "CONTEXT_TASK_COMPLETED", "明确批准后重新整理并完成覆盖流程");

  const retry = new AgentOrchestrator(new FailOnceProvider());
  const blocked = await retry.handleMessage("只整理这份材料", { taskId: blockedTask, projectId: `${projectId}-retry`, materialPath: sourcePath });
  const recovered = await retry.handleMessage("重试", { taskId: blockedTask, projectId: `${projectId}-retry`, materialPath: sourcePath });
  check("REPROCESS-06", blocked.state.id === "EXECUTION_BLOCKED" && recovered.state.id === "CONTEXT_TASK_COMPLETED", "Context 分析中断后重试会重新执行分析，不进入阻塞循环");

  console.log(JSON.stringify({ evaluation_id: "material-reprocess-and-context-retry", summary: { total: results.length, passed: results.filter((item) => item.passed).length, failed: results.filter((item) => !item.passed).length }, results }, null, 2));
  const failed = results.some((item) => !item.passed);
  clean();
  if (failed) process.exit(1);
}

function clean() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  for (const project of [projectId, `${projectId}-retry`]) {
    for (const target of [
      path.join(PROJECT_ROOT, "context-workspace/drafts", project),
      path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskOne),
      path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskTwo),
      path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskThree),
      path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", blockedTask),
      path.join(PROJECT_ROOT, "context-workspace/workspace/projects", project),
    ]) fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  clean();
  process.exit(1);
});
