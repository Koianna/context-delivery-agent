#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import { createChangeSnapshot } from "./lib/change-snapshot.js";
import type { ChangeRequestInput } from "./lib/change-types.js";
import { readJson } from "./lib/repository.js";
import { validateChangeInput } from "./validate-change-output.js";

export function createTaskChangeSnapshot(taskId: string, inputPath: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "CHANGE_ANALYZING") throw new Error(`当前状态 ${state.current_state} 不允许创建变更快照`);
  const input = readJson<ChangeRequestInput>(inputPath);
  const errors = validateChangeInput(input, root);
  if (errors.length) throw new Error(`变更输入校验失败:\n${errors.join("\n")}`);
  if (input.request_meta.task_id !== taskId) throw new Error("变更输入 task_id 与运行任务不一致");
  const result = createChangeSnapshot(input, taskId, root, nowISO());
  state.task_mode = "CHANGE";
  state.return_state = input.task_snapshot.source_state;
  state.material_version = input.task_snapshot.material_version;
  state.context_version = input.task_snapshot.context_version;
  state.decision_ledger_version = input.task_snapshot.decision_ledger_version;
  state.prd_version = input.task_snapshot.prd_version;
  state.plan_version = input.task_snapshot.plan_version;
  state.latest_output_ref = result.manifestRef;
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "ARTIFACT_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "change_snapshot"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: null, skill_version: null,
    prompt_version: null, artifact_ref: result.manifestRef,
    details: { change_id: input.change_request.change_id, status: result.status, artifact_count: result.manifest.artifacts.length }
  });
  return { status: result.status, snapshot_ref: result.manifestRef, artifact_count: result.manifest.artifacts.length };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const inputArg = argVal(args, "--input");
  if (!taskId || !inputArg) {
    console.error("用法: create-change-snapshot.ts --task-id <id> --input <change-request.json>");
    process.exit(1);
  }
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.join(PROJECT_ROOT, inputArg);
  console.log(JSON.stringify(createTaskChangeSnapshot(taskId, inputPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
