#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT,
  appendEvent,
  idempotencyKey,
  nowISO,
  readPendingConfirmations,
  readTaskState,
  uid,
  writeTaskState,
} from "./lib/config.js";
import type { ContextAnalysisOutput, ContextProposal } from "./lib/context-types.js";
import { authorizeContextWrite } from "./lib/context-write.js";
import { createVersion } from "./create-version.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";
import { updateIndex } from "./update-index.js";

export function applyContextActions(
  taskId: string,
  analysisPath: string,
  root = PROJECT_ROOT,
  logRef = "repo://context-workspace/workspace/reports/context-change-log.json"
) {
  const state = readTaskState();
  const pending = readPendingConfirmations();
  if (!state || state.task_id !== taskId || !pending || pending.task_id !== taskId) {
    throw new Error(`任务 ${taskId} 的状态或确认记录不存在`);
  }
  const analysis = readJson<ContextAnalysisOutput>(analysisPath);
  const latestApproved = [...pending.records].reverse().find(
    (record) => record.confirmation_type === "CONTEXT_UPDATE"
  );
  if (!latestApproved || latestApproved.status !== "APPROVED") {
    throw new Error("最新 CP-C01 记录未批准");
  }
  const approvedIds = new Set(
    latestApproved.items
      .filter((item) => item.approval_status === "APPROVED")
      .map((item) => item.proposal_id)
      .filter((id): id is string => typeof id === "string")
  );
  const proposals = analysis.update_proposals.filter((proposal) => approvedIds.has(proposal.proposal_id));
  if (proposals.length === 0) throw new Error("CP-C01 没有授权当前分析结果中的 proposal");

  const preflightErrors = proposals.flatMap((proposal) =>
    authorizeContextWrite({ taskState: state, confirmations: pending.records, proposal, root })
      .map((error) => `${proposal.proposal_id}: ${error}`)
  );
  if (preflightErrors.length) throw new Error(`Context 写入预检失败:\n${preflightErrors.join("\n")}`);

  const executed: string[] = [];
  const skipped: Array<{ proposal_id: string; reason: string }> = [];
  const versions: Array<{ proposal_id: string; version: string; target_ref: string }> = [];
  for (const proposal of proposals) {
    const result = executeProposal(proposal, latestApproved.resolved_at ?? nowISO(), root);
    if (result.status === "CREATED") executed.push(proposal.proposal_id);
    else skipped.push({ proposal_id: proposal.proposal_id, reason: "候选内容与当前内容一致" });
    versions.push({ proposal_id: proposal.proposal_id, version: result.version, target_ref: result.target_ref });
  }

  const index = updateIndex(root, "2026-08-04", state.project_id);
  const logPath = repoRefToPath(logRef, root);
  const changeLog = {
    artifact_id: `context-change-log-${state.project_id}`,
    version: "0.1.0",
    task_id: taskId,
    confirmation_id: latestApproved.confirmation_id,
    executed_actions: executed,
    skipped_actions: skipped,
    versions,
    index,
    created_at: latestApproved.resolved_at ?? nowISO()
  };
  writeJsonAtomic(logPath, changeLog);

  state.context_version = index.version;
  state.latest_output_ref = pathToRepoRef(logPath, root);
  state.skill_versions["context-maintain"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "VERSION_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "context_apply"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "context-maintain", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(logPath, root),
    details: { executed, skipped, index }
  });
  return {
    action: "APPLY",
    executed_actions: executed,
    skipped_actions: skipped,
    failed_actions: [],
    new_context_version: index.version,
    new_index_version: index.version,
    change_log_ref: pathToRepoRef(logPath, root),
    health_check: { status: "PASS", remaining_issues: analysis.remaining_questions }
  };
}

function executeProposal(proposal: ContextProposal, confirmedAt: string, root: string) {
  if (!proposal.target_ref || !proposal.content_ref || !proposal.base_version) {
    throw new Error(`${proposal.proposal_id} 缺少版本写入参数`);
  }
  return createVersion({
    targetRef: proposal.target_ref,
    contentRef: proposal.content_ref,
    expectedVersion: proposal.base_version,
    sourceRefs: proposal.source_refs,
    confirmedAt,
    root,
  });
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const analysisArg = argVal(args, "--analysis");
  if (!taskId || !analysisArg) {
    console.error("用法: apply-context-actions.ts --task-id <id> --analysis <json>");
    process.exit(1);
  }
  const analysisPath = path.isAbsolute(analysisArg) ? analysisArg : path.join(PROJECT_ROOT, analysisArg);
  console.log(JSON.stringify(applyContextActions(taskId, analysisPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
