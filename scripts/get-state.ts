#!/usr/bin/env npx tsx
// ============================================================
// get-state.ts — 读取\初始化任务状态
// ============================================================

import {
  readTaskState,
  writeTaskState,
  readPendingConfirmations,
  loadStates,
  isValidState,
} from "./lib/config.js";
import type { TaskState, StateId } from "./lib/types.js";

function usage(): never {
  console.error(
    "用法: npx tsx scripts/get-state.ts --task-id <id> [--init] [--project-id <id>]"
  );
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);

  const taskId = argVal(args, "--task-id");
  if (!taskId) usage();

  const init = args.includes("--init");
  const projectId = argVal(args, "--project-id") ?? "help-center-search";

  // 初始化模式
  if (init) {
    const existing = readTaskState();
    if (existing) {
      console.error(`任务已存在: ${existing.task_id}, 当前状态: ${existing.current_state}`);
      process.exit(1);
    }

    const newState: TaskState = {
      task_id: taskId,
      project_id: projectId,
      session_id: `session_${Date.now()}`,
      task_mode: null,
      current_state: "INITIALIZING" as StateId,
      previous_state: null,
      return_state: null,
      task_goal: "",
      completed_steps: [],
      pending_confirmation: null,
      material_version: "0.1.0",
      context_version: "0.1.0",
      decision_ledger_version: "0.1.0",
      prd_version: "0.1.0",
      plan_version: "0.1.0",
      latest_output_ref: null,
      retry_count: 0,
      replan_count: 0,
      error_info: null,
      git_commit: null,
      prompt_versions: {},
      skill_versions: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    writeTaskState(newState);
    console.log(JSON.stringify({ status: "created", state: newState }, null, 2));
    return;
  }

  // 读取模式
  const state = readTaskState();
  if (!state) {
    console.error(`任务 ${taskId} 不存在，请先使用 --init 初始化`);
    process.exit(1);
  }

  if (state.task_id !== taskId) {
    console.error(`任务 ID 不匹配: 期望 ${taskId}, 实际 ${state.task_id}`);
    process.exit(1);
  }

  const confirmations = readPendingConfirmations();

  // 附加状态机元数据
  const allStates = loadStates();
  const currentStateDef = allStates.find((s) => s.id === state.current_state);

  const output = {
    status: "ok",
    state,
    meta: {
      current_state_name: currentStateDef?.name ?? "未知",
      current_state_type: currentStateDef?.type ?? "未知",
      total_states: allStates.length,
      pending_confirmation_count: confirmations?.records.filter(
        (r) => r.status === "PENDING"
      ).length ?? 0,
      pending_confirmations: confirmations?.records.filter(
        (r) => r.status === "PENDING"
      ) ?? [],
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main();
