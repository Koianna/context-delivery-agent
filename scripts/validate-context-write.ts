#!/usr/bin/env npx tsx
import * as path from "node:path";
import { PROJECT_ROOT, readPendingConfirmations, readTaskState } from "./lib/config.js";
import type { ContextAnalysisOutput } from "./lib/context-types.js";
import { authorizeContextWrite } from "./lib/context-write.js";
import { readJson } from "./lib/repository.js";

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const analysisArg = argVal(args, "--analysis");
  const proposalId = argVal(args, "--proposal-id");
  if (!taskId || !analysisArg || !proposalId) {
    console.error("用法: validate-context-write.ts --task-id <id> --analysis <json> --proposal-id <id>");
    process.exit(1);
  }
  const state = readTaskState();
  const pending = readPendingConfirmations();
  if (!state || state.task_id !== taskId || !pending || pending.task_id !== taskId) {
    console.error(`任务 ${taskId} 的状态或确认记录不存在`);
    process.exit(1);
  }
  const analysisPath = path.isAbsolute(analysisArg) ? analysisArg : path.join(PROJECT_ROOT, analysisArg);
  const analysis = readJson<ContextAnalysisOutput>(analysisPath);
  const proposal = analysis.update_proposals.find((item) => item.proposal_id === proposalId);
  if (!proposal) {
    console.error(`proposal 不存在: ${proposalId}`);
    process.exit(1);
  }
  const errors = authorizeContextWrite({
    taskState: state,
    confirmations: pending.records,
    proposal,
  });
  console.log(JSON.stringify({ status: errors.length ? "DENIED" : "AUTHORIZED", proposal_id: proposalId, errors }, null, 2));
  if (errors.length) process.exit(1);
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main();
