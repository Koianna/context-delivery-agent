#!/usr/bin/env npx tsx
import {
  loadStates,
  readPendingConfirmations,
  readTaskState,
} from "./lib/config.js";
import { createTask } from "./lib/task-runtime.js";
import type { TaskState } from "./lib/types.js";

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  if (!taskId) usage();

  const mode = argVal(args, "--mode") as TaskState["task_mode"] | undefined;
  if (mode && !["CONTEXT", "PRD", "CHANGE"].includes(mode)) {
    throw new Error(`非法任务模式: ${mode}`);
  }
  if (args.includes("--init")) {
    const state = createTask({
      taskId,
      projectId: argVal(args, "--project-id"),
      mode,
      goal: argVal(args, "--goal"),
    });
    console.log(JSON.stringify({ status: "created", state }, null, 2));
    return;
  }

  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  const confirmations = readPendingConfirmations();
  const current = loadStates().find((item) => item.id === state.current_state);
  console.log(JSON.stringify({
    status: "ok",
    state,
    meta: {
      current_state_name: current?.name ?? "未知",
      current_state_type: current?.type ?? "未知",
      total_states: loadStates().length,
      pending_confirmation_count: confirmations?.records.filter(
        (record) => record.status === "PENDING"
      ).length ?? 0,
      pending_confirmations: confirmations?.records.filter(
        (record) => record.status === "PENDING"
      ) ?? [],
    },
  }, null, 2));
}

function usage(): never {
  console.error("用法: get-state.ts --task-id <id> [--init] [--project-id <id>] [--mode CONTEXT|PRD|CHANGE] [--goal <text>]");
  process.exit(1);
}
function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
