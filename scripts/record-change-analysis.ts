#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { ChangeAnalysisOutput, ChangeRequestInput } from "./lib/change-types.js";
import { pathToRepoRef, readJson, writeJsonAtomic } from "./lib/repository.js";
import { validateChangeAnalysis } from "./validate-change-output.js";

export function recordChangeAnalysis(taskId: string, inputPath: string, outputPath: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "CHANGE_ANALYZING") throw new Error(`当前状态 ${state.current_state} 不允许记录影响分析`);
  const input = readJson<ChangeRequestInput>(inputPath);
  const output = readJson<ChangeAnalysisOutput>(outputPath);
  const errors = validateChangeAnalysis(input, output, root);
  if (errors.length) throw new Error(`change-impact/ANALYZE 输出校验失败:\n${errors.join("\n")}`);
  const reportPath = path.join(root, "context-workspace/workspace/reports/change-impact.json");
  writeJsonAtomic(reportPath, output);
  state.latest_output_ref = pathToRepoRef(reportPath, root);
  state.skill_versions["change-impact"] = "0.2.0";
  state.prompt_versions["change-impact"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "SKILL_RESULT", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "change_analyze"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "change-impact", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(reportPath, root),
    details: { change_type: output.change_classification.change_type, return_state: output.recommended_return_state }
  });
  return { status: "RECORDED", report_ref: pathToRepoRef(reportPath, root), recommended_return_state: output.recommended_return_state };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const inputArg = argVal(args, "--input");
  const outputArg = argVal(args, "--output");
  if (!taskId || !inputArg || !outputArg) {
    console.error("用法: record-change-analysis.ts --task-id <id> --input <json> --output <json>");
    process.exit(1);
  }
  console.log(JSON.stringify(recordChangeAnalysis(taskId, resolveArg(inputArg), resolveArg(outputArg)), null, 2));
}

function resolveArg(value: string): string { return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value); }
function argVal(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
if (require.main === module) main();
