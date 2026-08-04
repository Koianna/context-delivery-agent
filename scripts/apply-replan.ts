#!/usr/bin/env npx tsx
import {
  PROJECT_ROOT, appendEvent, getLatestConfirmation, idempotencyKey, loadGuards, nowISO,
  readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import { validateReplanApproval } from "./lib/change-guards.js";
import type { ReplanOutput } from "./lib/change-types.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";

export function applyApprovedReplan(taskId: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "WAITING_REPLAN_CONFIRM") throw new Error(`当前状态 ${state.current_state} 不允许应用重规划`);
  const confirmation = getLatestConfirmation(taskId, "WAITING_REPLAN_CONFIRM", "REPLAN_APPROVAL");
  const guardErrors = validateReplanApproval(confirmation, taskId, undefined, root);
  if (guardErrors.length) throw new Error(`CP-R01 校验失败:\n${guardErrors.join("\n")}`);
  const payload = confirmation!.items[0];
  const planRef = payload.plan_ref as string;
  const planPath = repoRefToPath(planRef, root);
  const plan = readJson<ReplanOutput>(planPath);
  const returnState = payload.approved_return_state as typeof plan.plan.recommended_return_state;

  if (state.plan_version === plan.plan.version && state.return_state === returnState && plan.plan.status === "APPROVED") {
    return { status: "UNCHANGED", plan_ref: planRef, plan_version: plan.plan.version, return_state: returnState };
  }
  if (state.replan_count >= loadGuards().max_replan) throw new Error("REPLAN_LIMIT_REACHED: 重规划次数达到上限");
  if (state.plan_version !== plan.plan.previous_version) throw new Error("计划基线版本冲突");
  if (plan.plan.status !== "DRAFT") throw new Error("待批准计划状态必须是 DRAFT");

  const approvedPlan: ReplanOutput = { ...plan, plan: { ...plan.plan, status: "APPROVED" } };
  writeJsonAtomic(planPath, approvedPlan);
  state.plan_version = plan.plan.version;
  state.return_state = returnState;
  state.replan_count += 1;
  state.latest_output_ref = planRef;
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "VERSION_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "apply_replan"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "change-impact", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(planPath, root),
    details: { plan_version: plan.plan.version, return_state: returnState, replan_count: state.replan_count }
  });
  return { status: "APPLIED", plan_ref: planRef, plan_version: plan.plan.version, return_state: returnState };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  if (!taskId) {
    console.error("用法: apply-replan.ts --task-id <id>");
    process.exit(1);
  }
  console.log(JSON.stringify(applyApprovedReplan(taskId), null, 2));
}

function argVal(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
if (require.main === module) main();
