#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { ChangeAnalysisOutput, ReplanOutput } from "./lib/change-types.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";
import { validateReplan } from "./validate-change-output.js";

export function recordReplan(
  taskId: string,
  outputPath: string,
  root = PROJECT_ROOT,
  planRef = "repo://context-workspace/workspace/plans/help-center-search-replan.json"
) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "REPLANNING") throw new Error(`当前状态 ${state.current_state} 不允许记录重规划`);
  const output = readJson<ReplanOutput>(outputPath);
  const analysis = readJson<ChangeAnalysisOutput>(repoRefToPath(output.analysis_ref, root));
  const errors = validateReplan(analysis, output, root);
  if (errors.length) throw new Error(`change-impact/REPLAN 输出校验失败:\n${errors.join("\n")}`);
  if (output.plan.previous_version !== state.plan_version) throw new Error("重规划 previous_version 与任务计划基线不一致");
  const planPath = repoRefToPath(planRef, root);
  writeJsonAtomic(planPath, output);
  state.latest_output_ref = pathToRepoRef(planPath, root);
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "SKILL_RESULT", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "change_replan"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "change-impact", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(planPath, root),
    details: { plan_version: output.plan.version, return_state: output.plan.recommended_return_state, status: "DRAFT" }
  });
  return { status: "RECORDED", plan_ref: pathToRepoRef(planPath, root), plan_version: output.plan.version };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const outputArg = argVal(args, "--output");
  if (!taskId || !outputArg) {
    console.error("用法: record-replan.ts --task-id <id> --output <replan.json>");
    process.exit(1);
  }
  const outputPath = path.isAbsolute(outputArg) ? outputArg : path.join(PROJECT_ROOT, outputArg);
  console.log(JSON.stringify(recordReplan(taskId, outputPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
if (require.main === module) main();
