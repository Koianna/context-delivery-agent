#!/usr/bin/env npx tsx
import { loadStates, readTaskState } from "./lib/config.js";
import { listLegalTransitions, transitionTask } from "./lib/state-runtime.js";
import type { Operator, StateId } from "./lib/types.js";

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  if (!taskId) usage();
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);

  if (args.includes("--list-legal")) {
    console.log(JSON.stringify({
      from: state.current_state,
      legal_targets: listLegalTransitions(state.current_state, state),
      current_state_type: loadStates().find((item) => item.id === state.current_state)?.type,
    }, null, 2));
    return;
  }
  const toState = argVal(args, "--to-state") as StateId | undefined;
  if (!toState) usage();
  const result = transitionTask({
    taskId,
    toState,
    reason: argVal(args, "--reason"),
    operator: (argVal(args, "--operator") as Operator | undefined) ?? "AGENT",
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function usage(): never {
  console.error("用法: transition-state.ts --task-id <id> --to-state <STATE_ID> [--reason <text>] [--operator USER|AGENT|SYSTEM] [--dry-run] [--list-legal]");
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
