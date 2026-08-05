import {
  appendEvent,
  getConfirmationTypeForState,
  getLatestConfirmation,
  hasPendingConfirmationForState,
  idempotencyKey,
  isLegalTransition,
  loadGuards,
  loadStates,
  loadTransitions,
  nowISO,
  PROJECT_ROOT,
  readTaskState,
  stateRequiresConfirmation,
  uid,
  writeTaskState,
} from "./config.js";
import {
  validateAppliedReplan,
  validateChangeCancellation,
  validateReplanRevision,
} from "./change-guards.js";
import {
  validateCoreConfirmation,
  validateDeliveryConfirmation,
  validatePrdEntryConfirmation,
} from "./prd-guards.js";
import type { Operator, StateId, TaskState, TransitionResult } from "./types.js";

export interface TransitionTaskInput {
  taskId: string;
  toState: StateId;
  reason?: string;
  operator?: Operator;
  dryRun?: boolean;
}

export function transitionTask(input: TransitionTaskInput): TransitionResult {
  const state = readTaskState();
  if (!state || state.task_id !== input.taskId) {
    throw new Error(`任务 ${input.taskId} 不存在`);
  }
  const from = state.current_state;
  const to = input.toState;
  const reason = input.reason ?? "未提供理由";
  const operator = input.operator ?? "AGENT";

  if (!loadStates().some((item) => item.id === to)) {
    return reject(state, to, `非法目标状态: ${to}`, reason, operator);
  }
  if (!isLegalTransition(from, to) && !isSpecialTransition(from, to, state)) {
    return reject(
      state,
      to,
      `状态 ${from} 不允许直接转移到 ${to}`,
      reason,
      operator
    );
  }
  if (stateRequiresConfirmation(to) && !hasPendingConfirmationForState(input.taskId, to)) {
    return reject(
      state,
      to,
      `状态 ${to} 要求存在 PENDING 确认记录（类型: ${getConfirmationTypeForState(to)}）`,
      reason,
      operator
    );
  }

  const guardErrors = validateTransitionGuards(state, to);
  if (guardErrors.length) {
    return reject(state, to, guardErrors.join("; "), reason, operator);
  }

  if (input.dryRun) return { ok: true, from, to, reason: `[DRY-RUN] ${reason}` };

  const activeConfirmation = stateRequiresConfirmation(to)
    ? getLatestConfirmation(input.taskId, to)
    : undefined;
  const nextState: TaskState = {
    ...state,
    previous_state: from,
    current_state: to,
    completed_steps: [...state.completed_steps, from],
    pending_confirmation: activeConfirmation?.confirmation_id ?? null,
  };
  writeTaskState(nextState);
  appendEvent({
    event_id: uid(),
    event_type: "STATE_TRANSITION",
    task_id: input.taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(input.taskId, `transition_${from}_to_${to}`),
    timestamp: nowISO(),
    operator,
    current_state: to,
    previous_state: from,
    skill_name: null,
    skill_version: null,
    prompt_version: null,
    artifact_ref: null,
    details: {},
    reason,
  });
  return { ok: true, from, to, reason };
}

export function assertTransition(input: TransitionTaskInput): Extract<TransitionResult, { ok: true }> {
  const result = transitionTask(input);
  if (!result.ok) throw new Error(result.error);
  return result;
}

export function listLegalTransitions(from: StateId, state?: TaskState): string[] {
  const current = state ?? readTaskState();
  const targets = loadTransitions()
    .filter((transition) => transition.from === from)
    .map((transition) => transition.to);
  if (from === "TASK_PAUSED") targets.push("PREVIOUS_STATE");
  if (from === "EXECUTION_BLOCKED") targets.push("PREVIOUS_VALID_STATE");
  if (from === "WAITING_REPLAN_CONFIRM" && current?.return_state) {
    targets.push(current.return_state);
  }
  if (from !== "TASK_CANCELLED") targets.push("TASK_PAUSED", "TASK_CANCELLED");
  return [...new Set(targets)];
}

function validateTransitionGuards(state: TaskState, to: StateId): string[] {
  const from = state.current_state;
  const taskId = state.task_id;
  const errors: string[] = [];

  if (from === "WAITING_CONTEXT_CONFIRM" && to === "CONTEXT_MAINTAINING") {
    const confirmation = getLatestConfirmation(
      taskId,
      "WAITING_CONTEXT_CONFIRM",
      "CONTEXT_UPDATE"
    );
    if (!confirmation || confirmation.status !== "APPROVED") {
      errors.push("CP-C01 尚未批准");
    } else if (!confirmation.items.some((item) => item.approval_status === "APPROVED")) {
      errors.push("CP-C01 没有逐项批准的 proposal");
    }
  }
  if (from === "WAITING_DECISION_CONFIRM" && to === "PRD_DRAFTING_CORE") {
    errors.push(...validatePrdEntryConfirmation(
      getLatestConfirmation(taskId, from, "DECISION_AND_WRITABLE_STATUS"),
      taskId
    ));
  }
  if (from === "WAITING_SCOPE_CONFIRM" && to === "PRD_DRAFTING_DETAILS") {
    errors.push(...validateCoreConfirmation(
      getLatestConfirmation(taskId, from, "SCOPE_AND_CORE_FLOW"),
      taskId
    ));
  }
  if (from === "WAITING_REVIEW_DECISION" && to === "DELIVERED") {
    errors.push(...validateDeliveryConfirmation(
      getLatestConfirmation(taskId, from, "REVIEW_DISPOSITION"),
      taskId
    ));
  }
  if (from === "WAITING_REPLAN_CONFIRM") {
    const confirmation = getLatestConfirmation(taskId, from, "REPLAN_APPROVAL");
    if (confirmation?.resolution === "APPROVE_REPLAN") {
      errors.push(...validateAppliedReplan(
        confirmation,
        state,
        to,
        loadGuards().max_replan,
        PROJECT_ROOT
      ));
    } else if (confirmation?.resolution === "REVISE_REPLAN" && to === "REPLANNING") {
      errors.push(...validateReplanRevision(confirmation, taskId));
    } else if (confirmation?.resolution === "CANCEL_CHANGE") {
      errors.push(...validateChangeCancellation(confirmation, taskId, to, PROJECT_ROOT));
      if (state.return_state !== to) errors.push("任务返回节点与快照原状态不一致");
    } else {
      errors.push("CP-R01 没有与目标状态匹配的已完成决定");
    }
  }

  if (
    from === "TASK_CANCELLED" &&
    to !== "INITIALIZING" &&
    to !== "INTENT_ROUTING"
  ) {
    errors.push("已取消任务不能恢复到业务状态");
  }
  const terminalStates: StateId[] = ["CONTEXT_TASK_COMPLETED", "DELIVERED"];
  if (
    terminalStates.includes(from) &&
    !["PRD_THINKING", "INTENT_ROUTING", "INITIALIZING"].includes(to)
  ) {
    errors.push(`终态 ${from} 只能通过新任务入口转移`);
  }
  return errors;
}

function isSpecialTransition(from: StateId, to: StateId, state: TaskState): boolean {
  if (from === "TASK_PAUSED" && state.previous_state === to) return true;
  if (from === "EXECUTION_BLOCKED" && state.previous_state === to) return true;
  if (from === "WAITING_REPLAN_CONFIRM" && state.return_state === to) return true;
  if (to === "TASK_PAUSED" && !["TASK_CANCELLED", "DELIVERED", "CONTEXT_TASK_COMPLETED"].includes(from)) {
    return true;
  }
  if (to === "TASK_CANCELLED" && !["TASK_CANCELLED", "DELIVERED", "CONTEXT_TASK_COMPLETED"].includes(from)) {
    return true;
  }
  return false;
}

function reject(
  state: TaskState,
  requested: StateId,
  error: string,
  reason: string,
  operator: Operator
): TransitionResult {
  appendEvent({
    event_id: uid(),
    event_type: "ERROR",
    task_id: state.task_id,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(state.task_id, "transition_rejected"),
    timestamp: nowISO(),
    operator,
    current_state: state.current_state,
    previous_state: state.current_state,
    skill_name: null,
    skill_version: null,
    prompt_version: null,
    artifact_ref: null,
    details: { error, requested, reason },
  });
  return { ok: false, from: state.current_state, requested, error };
}
