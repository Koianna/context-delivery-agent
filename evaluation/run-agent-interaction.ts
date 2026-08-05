#!/usr/bin/env npx tsx
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { PROJECT_ROOT, readPendingConfirmations, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";

interface CaseResult { case_id: string; passed: boolean; detail: string }
const results: CaseResult[] = [];
const transcript: Array<{ user: string; response: ReturnType<AgentOrchestrator["handleMessage"]> }> = [];
const taskId = `agent-eval-${Date.now()}`;
const agent = new AgentOrchestrator();

clearRuntime();
clearAgentArtifacts(taskId);
const turn = (user: string) => {
  const response = agent.handleMessage(user, { taskId, debug: true });
  transcript.push({ user, response });
  return response;
};
const check = (caseId: string, passed: boolean, detail: string) => {
  results.push({ case_id: caseId, passed, detail });
};

const context = turn("只整理帮助中心搜索材料，不写 PRD");
check(
  "AGENT-01",
  context.state.id === "WAITING_CONTEXT_CONFIRM" && context.status === "WAITING_CONFIRMATION",
  "自然语言输入自动路由到 Context，并停在 CP-C01"
);
const beforeContextConfirm = readTaskState();
check(
  "AGENT-02",
  beforeContextConfirm?.context_version === "0.1.0" && context.confirmation?.items.length === 2,
  "人工确认前没有提升 Context 版本，且只展示两条稳定变更"
);

const contextDone = turn("确认全部");
check(
  "AGENT-03",
  contextDone.state.id === "CONTEXT_TASK_COMPLETED" && contextDone.artifacts.some((item) => fileExists(item.ref)),
  "自然语言确认后执行 Context APPLY 并落盘"
);

const p01 = turn("继续准备 PRD");
check(
  "AGENT-04",
  p01.state.id === "WAITING_DECISION_CONFIRM" && !p01.artifacts.some((item) => item.label.includes("PRD 主体")),
  "prd-thinking 后先停在 CP-P01，未提前生成 PRD"
);
const p02 = turn("按建议确认，可以生成 PRD");
check(
  "AGENT-05",
  p02.state.id === "WAITING_SCOPE_CONFIRM" && p02.artifacts.some((item) => item.label === "PRD 主体" && fileExists(item.ref)),
  "CP-P01 后生成 CORE，并停在 CP-P02"
);
const p03 = turn("确认范围和核心流程");
check(
  "AGENT-06",
  p03.state.id === "WAITING_REVIEW_DECISION" && p03.artifacts.some((item) => item.label === "PRD 独立审核报告" && fileExists(item.ref)),
  "CP-P02 后生成 DETAILS、独立审核并停在 CP-P03"
);
const delivered = turn("接受 P2 并交付");
check(
  "AGENT-07",
  delivered.state.id === "DELIVERED" && delivered.artifacts.every((item) => fileExists(item.ref)),
  "CP-P03 后交付 PRD，决策账本和审核报告可追溯"
);

const change = turn("修改已交付需求：目标文章下线或目标标签删除后，系统自动停用相关别名并展示原因，产品审核后可重新启用");
check(
  "AGENT-08",
  change.state.id === "WAITING_REPLAN_CONFIRM" && change.artifacts.every((item) => fileExists(item.ref)),
  "自然语言变更自动完成快照、影响分析、重规划并停在 CP-R01"
);
const beforeReplan = readTaskState();
check(
  "AGENT-09",
  beforeReplan?.plan_version === "0.1.0" && beforeReplan.replan_count === 0,
  "CP-R01 前没有应用新计划"
);
const replanned = turn("批准重规划");
check(
  "AGENT-10",
  replanned.state.id === "PRD_DRAFTING_DETAILS" && readTaskState()?.replan_count === 1,
  "批准后只返回最小 DETAILS 修订节点"
);

const confirmations = readPendingConfirmations()?.records ?? [];
const expectedTypes = new Set([
  "CONTEXT_UPDATE",
  "DECISION_AND_WRITABLE_STATUS",
  "SCOPE_AND_CORE_FLOW",
  "REVIEW_DISPOSITION",
  "REPLAN_APPROVAL",
]);
check(
  "AGENT-11",
  [...expectedTypes].every((type) => confirmations.some((item) => item.confirmation_type === type && item.status === "APPROVED")),
  "五个核心人工确认点均留下已批准记录"
);
check(
  "AGENT-12",
  transcript.every((item) => item.response.provider.id === "local-case") && transcript.every((item) => !item.response.message.includes("npx")),
  "用户响应明确 Provider 且不暴露脚本命令作为交互方式"
);

const passed = results.filter((item) => item.passed).length;
const executionLog = { provider: "local-case", transcript: sanitizeTranscript(transcript) };
const report = {
  evaluation_id: "agent-natural-language-interaction",
  eval_set_version: "0.1.0",
  git_commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(),
  provider: "local-case",
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
  execution_log: process.argv.includes("--write-result")
    ? "repo://evaluation/execution-logs/agent-interaction-demo.json"
    : undefined,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--write-result")) {
  const resultPath = path.join(PROJECT_ROOT, "evaluation/results/agent-interaction.latest.json");
  const logPath = path.join(PROJECT_ROOT, "evaluation/execution-logs/agent-interaction-demo.json");
  fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  fs.writeFileSync(logPath, JSON.stringify(executionLog, null, 2) + "\n", "utf-8");
}
clearRuntime();
clearAgentArtifacts(taskId);
if (passed !== results.length) process.exit(1);

function fileExists(ref: string): boolean {
  try { return fs.existsSync(repoRefToPath(ref, PROJECT_ROOT)); } catch { return false; }
}

function clearRuntime() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
}

function clearAgentArtifacts(dynamicTaskId: string) {
  const slug = dynamicTaskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const changeId = `change-target-unavailable-${slug}`.slice(0, 80);
  for (const target of [
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", slug),
    path.join(PROJECT_ROOT, "context-workspace/workspace/prd", `help-center-search-${slug}.md`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/reports", `change-impact-${slug}.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/plans", `help-center-search-${slug}-replan.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/snapshots", changeId),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function sanitizeTranscript(
  items: Array<{ user: string; response: ReturnType<AgentOrchestrator["handleMessage"]> }>
) {
  return replaceDynamicIds(items.map(({ user, response }) => ({
    user,
    response: {
      ...response,
      confirmation: response.confirmation
        ? { ...response.confirmation, id: "confirm_demo" }
        : undefined,
      debug: response.debug
        ? { ...response.debug, task_id: "agent-demo" }
        : undefined,
    },
  })), taskId) as typeof items;
}

function replaceDynamicIds<T>(value: T, dynamicTaskId: string): T {
  if (typeof value === "string") {
    return value.replaceAll(dynamicTaskId, "agent-demo") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceDynamicIds(item, dynamicTaskId)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceDynamicIds(item, dynamicTaskId)])
    ) as T;
  }
  return value;
}
