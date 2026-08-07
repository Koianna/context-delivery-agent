#!/usr/bin/env npx tsx
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { WorkspaceProvider } from "../scripts/agent/workspace-provider.js";
import { PROJECT_ROOT, readPendingConfirmations, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";

interface CaseResult { case_id: string; passed: boolean; detail: string }
class EvaluationModelProvider extends WorkspaceProvider {
  override readonly id = "evaluation-model";
  override readonly label = "状态机回归模型替身";
  override readonly generationMode: "model" = "model";
}
const results: CaseResult[] = [];
const transcript: Array<{ user: string; response: Awaited<ReturnType<AgentOrchestrator["handleMessage"]>> }> = [];
const taskId = `agent-eval-${Date.now()}`;
const projectId = "evaluation-product";
const sourceDir = path.join(PROJECT_ROOT, "runtime/agent-interaction-materials");
const sourcePath = path.join(sourceDir, "产品现状.md");
const agent = new AgentOrchestrator(new EvaluationModelProvider());

async function main() {
clearRuntime();
clearAgentArtifacts(taskId);
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(sourcePath, "---\nsource_type: PRODUCT_DOC\nsource_owner: 产品团队\nsource_time: 2026-08-06T10:00:00+08:00\n---\n\n当前项目支持用户提交材料并查看处理结果。\n", "utf-8");
const turn = async (user: string) => {
  const response = await agent.handleMessage(user, { taskId, projectId, materialPath: sourcePath, debug: true });
  transcript.push({ user, response });
  return response;
};
const controlTurn = async (user: string) => {
  const response = await agent.handleMessage(user, { taskId, projectId, debug: true });
  transcript.push({ user, response });
  return response;
};
const check = (caseId: string, passed: boolean, detail: string) => {
  results.push({ case_id: caseId, passed, detail });
};

const context = await turn("请整理这份会议记录，先不要写 PRD");
check(
  "AGENT-01",
  context.state.id === "CONTEXT_TASK_COMPLETED" && context.status === "COMPLETED",
  "自然语言输入自动路由到 Context 并完成可逆整理"
);
const beforeContextConfirm = readTaskState();
check(
  "AGENT-02",
  beforeContextConfirm?.context_version === "0.1.0" && !context.confirmation,
  "没有稳定 Context 变更时不创建确认点或提升 Context 版本"
);

const contextDone = context;
check(
  "AGENT-03",
  contextDone.state.id === "CONTEXT_TASK_COMPLETED" && contextDone.artifacts.some((item) => fileExists(item.ref)),
  "自然语言整理完成后返回 Runtime 产物并落盘"
);

const p01 = await turn("继续准备 PRD");
check(
  "AGENT-04",
  p01.state.id === "WAITING_DECISION_CONFIRM"
    && !p01.artifacts.some((item) => item.label.includes("PRD 主体"))
    && !fs.existsSync(path.join(PROJECT_ROOT, "runtime/provider-output", taskId, "prd.core.md"))
    && !fs.existsSync(path.join(PROJECT_ROOT, "runtime/provider-output", taskId, "prd.details.md")),
  "prd-thinking 后先停在 CP-P01，未提前生成 PRD"
);
const p02 = await turn("按建议确认，可以生成 PRD");
check(
  "AGENT-05",
  p02.state.id === "WAITING_SCOPE_CONFIRM" && p02.artifacts.some((item) => item.label === "PRD 主体" && fileExists(item.ref)),
  "CP-P01 后生成 CORE，并停在 CP-P02"
);
const p03 = await turn("确认范围和核心流程");
check(
  "AGENT-06",
  p03.state.id === "WAITING_REVIEW_DECISION" && p03.artifacts.some((item) => item.label === "PRD 独立审核报告" && fileExists(item.ref)),
  "CP-P02 后生成 DETAILS、独立审核并停在 CP-P03"
);
const firstP03Id = p03.confirmation?.id;
await controlTurn("暂停");
const resumedP03 = await controlTurn("继续");
check(
  "AGENT-06D",
  resumedP03.state.id === "WAITING_REVIEW_DECISION"
    && resumedP03.confirmation?.id === firstP03Id
    && readPendingConfirmations()?.records.find((item) => item.confirmation_id === firstP03Id)?.status === "PENDING",
  "等待 CP-P03 时暂停和恢复会保留原确认，不将其误判为悬空记录"
);
const fixBeforeReview = await turn("先修复再审核");
check(
  "AGENT-06A",
  fixBeforeReview.state.id === "PRD_REVIEWING" && fixBeforeReview.status === "CONTINUE",
  "CP-P03 选择先修复后进入专用审核修订节点"
);
const revisionMessage = "补充具体修订决定。1）CONSISTENCY-01：P95<2 秒作为强制验收标准，移除“仅作为目标”表述，不达标即阻塞交付；2）SCOPE-01：冬季查询返回夏季商品纳入本期，双向修复季节错配；3）COMPLETENESS-01：拼音混合输入支持，仅转换纯字母部分，与中文合并后搜索；4）COMPLETENESS-02：PRD 内提供临时基线季节词表与类目供开发先行实现；5）COMPLETENESS-03：拼音置信度阈值暂定 0.8，后续可调。请按此修订并重新审核。";
const revised = await turn(revisionMessage);
const revisionConfirmations = readPendingConfirmations()?.records ?? [];
check(
  "AGENT-06B",
  revised.state.id === "WAITING_REVIEW_DECISION"
    && readTaskState()?.prd_version === "0.2.1"
    && revised.confirmation?.id !== firstP03Id,
  "具体修订决定生成 0.2.1 并在重新审核后创建新的 CP-P03"
);
check(
  "AGENT-06C",
  !revisionConfirmations.some((item) => item.confirmation_type === "INTENT_CLARIFICATION")
    && revisionConfirmations.filter((item) => item.status === "PENDING").length === 1
    && revisionConfirmations.find((item) => item.status === "PENDING")?.confirmation_id === revised.confirmation?.id,
  "审核修订不进入意图澄清，也不留下悬空 PENDING 确认"
);
const delivered = await turn("接受 P2 并交付");
check(
  "AGENT-07",
  delivered.state.id === "DELIVERED" && delivered.artifacts.every((item) => fileExists(item.ref)),
  "CP-P03 后交付 PRD，决策账本和审核报告可追溯"
);

const change = await turn("修改已交付需求：目标文章下线或目标标签删除后，系统自动停用相关别名并展示原因，产品审核后可重新启用");
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
const replanned = await turn("批准重规划");
check(
  "AGENT-10",
  replanned.state.id === "PRD_DRAFTING_DETAILS" && readTaskState()?.replan_count === 1,
  "批准后只返回最小 DETAILS 修订节点"
);

const intentionallyBlocked = await controlTurn("这是一条无法归类的控制流回归输入");
const afterAtomicFailure = readPendingConfirmations()?.records ?? [];
check(
  "AGENT-13",
  intentionallyBlocked.state.id === "EXECUTION_BLOCKED"
    && afterAtomicFailure.some((item) => item.confirmation_type === "INTENT_CLARIFICATION" && item.status === "CANCELLED" && item.resolved_by === "SYSTEM")
    && !afterAtomicFailure.some((item) => item.status === "PENDING"),
  "非法等待态迁移会系统取消刚创建的确认，不留下悬空 PENDING"
);
await controlTurn("暂停");
await controlTurn("继续");
const retried = await controlTurn("重试");
check(
  "AGENT-14",
  retried.state.id === "PRD_DRAFTING_DETAILS"
    && !readPendingConfirmations()?.records.some((item) => item.status === "PENDING"),
  "阻塞态暂停后仍可通过继续和重试返回最近业务节点，不形成循环"
);

const confirmations = readPendingConfirmations()?.records ?? [];
const expectedTypes = new Set([
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
  transcript.every((item) => item.response.provider.id === "evaluation-model") && transcript.every((item) => !item.response.message.includes("npx")),
  "用户响应明确 Provider 且不暴露脚本命令作为交互方式"
);

const passed = results.filter((item) => item.passed).length;
const executionLog = { provider: "evaluation-model", project_id: projectId, transcript: sanitizeTranscript(transcript) };
const report = {
  evaluation_id: "agent-natural-language-interaction",
  eval_set_version: "0.1.0",
  git_commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(),
  provider: "evaluation-model",
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
}

function fileExists(ref: string): boolean {
  try { return fs.existsSync(repoRefToPath(ref, PROJECT_ROOT)); } catch { return false; }
}

function clearRuntime() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/agent-interaction-materials"), { recursive: true, force: true });
}

function clearAgentArtifacts(dynamicTaskId: string) {
  const slug = dynamicTaskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const changeId = `change-${projectId}-${slug}`.slice(0, 80);
  for (const target of [
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", slug),
    path.join(PROJECT_ROOT, "context-workspace/drafts", projectId),
    path.join(PROJECT_ROOT, "context-workspace/context", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId, "materials"),
    path.join(PROJECT_ROOT, "context-workspace/workspace/prd", `${projectId}-${slug}.md`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/reports", `change-impact-${slug}.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/plans", `${projectId}-${slug}-replan.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/snapshots", changeId),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  for (const directory of ["plans", "snapshots"]) {
    const target = path.join(PROJECT_ROOT, "context-workspace/workspace", directory);
    if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
  }
}

function sanitizeTranscript(
  items: Array<{ user: string; response: Awaited<ReturnType<AgentOrchestrator["handleMessage"]>> }>
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

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
