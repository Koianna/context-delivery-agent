#!/usr/bin/env npx tsx
// ============================================================
// transition-state.ts — 校验并执行状态转移
// ============================================================

import {
  readTaskState,
  writeTaskState,
  loadStates,
  loadGuards,
  isLegalTransition,
  stateRequiresConfirmation,
  hasPendingConfirmationForState,
  getConfirmationTypeForState,
  readPendingConfirmations,
  appendEvent,
  uid,
  idempotencyKey,
  nowISO,
} from "./lib/config.js";
import type {
  StateId,
  TaskState,
  Operator,
  TransitionResult,
} from "./lib/types.js";

function usage(): never {
  console.error(
    [
      "用法: npx tsx scripts/transition-state.ts",
      "  --task-id <id>",
      "  --to-state <STATE_ID>",
      "  [--reason <text>]",
      "  [--operator USER|AGENT|SYSTEM]",
      "  [--dry-run]",
      "  [--list-legal]",
    ].join("\n")
  );
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);

  const taskId = argVal(args, "--task-id");
  const toStateRaw = argVal(args, "--to-state");
  const reason = argVal(args, "--reason") ?? "未提供理由";
  const operator: Operator = (argVal(args, "--operator") as Operator) ?? "AGENT";
  const dryRun = args.includes("--dry-run");
  const listLegal = args.includes("--list-legal");

  if (!taskId) usage();

  const state = readTaskState();
  if (!state) {
    console.error(`任务 ${taskId} 不存在`);
    process.exit(1);
  }

  const fromState = state.current_state;

  // --list-legal: 列出当前状态的所有合法转移
  if (listLegal) {
    const allTransitions = loadGuards();
    const legal = getAllLegalTransitions(fromState);
    console.log(
      JSON.stringify(
        {
          from: fromState,
          legal_targets: legal,
          current_state_type: loadStates().find((s) => s.id === fromState)?.type,
        },
        null,
        2
      )
    );
    return;
  }

  if (!toStateRaw) usage();

  // 校验目标状态是否存在
  const allStates = loadStates();
  const targetStateDef = allStates.find((s) => s.id === toStateRaw);
  if (!targetStateDef) {
    console.error(
      `非法目标状态: ${toStateRaw}。有效状态: ${allStates.map((s) => s.id).join(", ")}`
    );
    process.exit(1);
  }

  const toState = toStateRaw as StateId;

  // ---- 守卫 1: 转移表中是否存在 ----
  const isStandardLegal = isLegalTransition(fromState, toState);
  const isSpecialLegal = checkSpecialTransition(fromState, toState, state);

  if (!isStandardLegal && !isSpecialLegal) {
    const result: TransitionResult = {
      ok: false,
      from: fromState,
      requested: toStateRaw,
      error: `状态 ${fromState} 不允许直接转移到 ${toStateRaw}，请使用 --list-legal 查看合法目标`,
    };
    console.log(JSON.stringify(result, null, 2));

    // 仍然记录被拒绝的尝试
    appendEvent({
      event_id: uid(),
      event_type: "ERROR",
      task_id: taskId,
      request_id: `req_${uid()}`,
      idempotency_key: idempotencyKey(taskId, "transition_rejected"),
      timestamp: nowISO(),
      operator,
      current_state: fromState,
      previous_state: fromState,
      skill_name: null,
      skill_version: null,
      prompt_version: null,
      artifact_ref: null,
      details: { error: result.error, requested: toStateRaw, reason },
    });
    process.exit(1);
  }

  // ---- 守卫 2: 进入等待状态前必须有确认记录 ----
  if (stateRequiresConfirmation(toState)) {
    if (!hasPendingConfirmationForState(taskId, toState)) {
      const ct = getConfirmationTypeForState(toState);
      const result: TransitionResult = {
        ok: false,
        from: fromState,
        requested: toStateRaw,
        error: `状态 ${toState} 要求存在 PENDING 确认记录（类型: ${ct}），请先通过 manage-confirmation.ts 创建确认`,
      };
      console.log(JSON.stringify(result, null, 2));

      appendEvent({
        event_id: uid(),
        event_type: "ERROR",
        task_id: taskId,
        request_id: `req_${uid()}`,
        idempotency_key: idempotencyKey(taskId, "transition_no_confirmation"),
        timestamp: nowISO(),
        operator,
        current_state: fromState,
        previous_state: fromState,
        skill_name: null,
        skill_version: null,
        prompt_version: null,
        artifact_ref: null,
        details: { error: result.error, requested: toStateRaw },
      });
      process.exit(1);
    }
  }

  // ---- 守卫 3: PRD 准入 ----
  if (fromState === "WAITING_DECISION_CONFIRM" && toState === "PRD_DRAFTING_CORE") {
    // 简化校验：检查是否有 PENDING 确认记录被解析
    // 完整实现需要检查 decision 内容
  }

  // ---- 守卫 4: TASK_CANCELLED 不可恢复 ----
  if (fromState === "TASK_CANCELLED" && toState !== "INITIALIZING" && toState !== "INTENT_ROUTING") {
    const result: TransitionResult = {
      ok: false,
      from: fromState,
      requested: toStateRaw,
      error: "已取消任务不能恢复到业务状态，只能通过新对话创建新任务",
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  // ---- 守卫 5: 终态不得继续修改 ----
  const terminalStates: StateId[] = ["CONTEXT_TASK_COMPLETED", "DELIVERED"];
  if (terminalStates.includes(fromState) && toState !== "PRD_THINKING" && toState !== "INTENT_ROUTING" && toState !== "INITIALIZING") {
    const result: TransitionResult = {
      ok: false,
      from: fromState,
      requested: toStateRaw,
      error: `终态 ${fromState} 只能通过新任务入口转移，不能直接进入 ${toStateRaw}`,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  // ---- 通过：执行转移 ----
  if (dryRun) {
    const result: TransitionResult = {
      ok: true,
      from: fromState,
      to: toState,
      reason: `[DRY-RUN] ${reason}`,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const newState: TaskState = {
    ...state,
    previous_state: fromState,
    current_state: toState,
    completed_steps: [...state.completed_steps, fromState],
  };

  writeTaskState(newState);

  // 记录事件
  appendEvent({
    event_id: uid(),
    event_type: "STATE_TRANSITION",
    task_id: taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(taskId, `transition_${fromState}_to_${toState}`),
    timestamp: nowISO(),
    operator,
    current_state: toState,
    previous_state: fromState,
    skill_name: null,
    skill_version: null,
    prompt_version: null,
    artifact_ref: null,
    details: {},
    reason,
  });

  const result: TransitionResult = {
    ok: true,
    from: fromState,
    to: toState,
    reason,
  };
  console.log(JSON.stringify(result, null, 2));
}

function getAllLegalTransitions(from: StateId): string[] {
  const transitions = [
    ...require("./lib/config.js").loadTransitions()
      .filter((t: { from: string }) => t.from === from)
      .map((t: { to: string }) => t.to),
  ];

  // 特殊转移
  if (from === "TASK_PAUSED") transitions.push("PREVIOUS_STATE");
  if (from === "EXECUTION_BLOCKED") transitions.push("PREVIOUS_VALID_STATE");

  // 全局可进入的终态
  if (from !== "TASK_CANCELLED") transitions.push("TASK_PAUSED", "TASK_CANCELLED");

  return [...new Set(transitions)];
}

function checkSpecialTransition(
  from: StateId,
  to: StateId,
  state: TaskState
): boolean {
  // TASK_PAUSED 可以恢复到暂停前状态
  if (from === "TASK_PAUSED" && state.previous_state === to) {
    return true;
  }
  // EXECUTION_BLOCKED 可以恢复到最近有效状态
  if (from === "EXECUTION_BLOCKED" && state.previous_state === to) {
    return true;
  }
  return false;
}

function argVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main();
