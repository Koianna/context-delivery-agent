#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { PrdThinkingOutput } from "./lib/prd-types.js";
import { validatePrdThinking } from "./validate-prd-output.js";
import { pathToRepoRef, readJson, writeJsonAtomic } from "./lib/repository.js";

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const outputArg = argVal(args, "--output");
  if (!taskId || !outputArg) {
    console.error("用法: record-prd-thinking.ts --task-id <id> --output <prd-thinking-output.json>");
    process.exit(1);
  }
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "PRD_THINKING") throw new Error(`当前状态 ${state.current_state} 不允许记录写前分析`);
  const outputPath = path.isAbsolute(outputArg) ? outputArg : path.join(PROJECT_ROOT, outputArg);
  const output = readJson<PrdThinkingOutput>(outputPath);
  const errors = validatePrdThinking(output);
  if (errors.length) throw new Error(`prd-thinking 输出校验失败:\n${errors.join("\n")}`);
  const reportPath = path.join(PROJECT_ROOT, "context-workspace/workspace/reports/prd-thinking.json");
  writeJsonAtomic(reportPath, output);
  state.latest_output_ref = pathToRepoRef(reportPath);
  state.skill_versions["prd-thinking"] = "0.2.0";
  state.prompt_versions["prd-thinking"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "SKILL_RESULT", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "prd_thinking"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "prd-thinking", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(reportPath),
    details: { writable_status: output.writable_assessment.status, blocker_count: output.writable_assessment.blockers.length }
  });
  console.log(JSON.stringify({ status: "RECORDED", report_ref: pathToRepoRef(reportPath) }, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main();
