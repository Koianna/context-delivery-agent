#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, getLatestConfirmation, idempotencyKey, nowISO,
  readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import { validatePrdEntryConfirmation } from "./lib/prd-guards.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";

interface ConfirmedLedger {
  artifact_id: string;
  version: string;
  decisions: Array<{ decision_id: string; status: string; decision: string }>;
  [key: string]: unknown;
}

export function recordConfirmedDecisions(
  taskId: string,
  ledgerPath: string,
  root = PROJECT_ROOT,
  targetRef = "repo://context-workspace/workspace/decisions/decision-ledger.json"
) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  const confirmation = getLatestConfirmation(taskId, "WAITING_DECISION_CONFIRM", "DECISION_AND_WRITABLE_STATUS");
  const guardErrors = validatePrdEntryConfirmation(confirmation, taskId);
  if (guardErrors.length) throw new Error(`CP-P01 校验失败:\n${guardErrors.join("\n")}`);
  const ledger = readJson<ConfirmedLedger>(ledgerPath);
  const confirmedIds = confirmation!.items[0].confirmed_decision_ids as string[];
  const ledgerIds = ledger.decisions.filter((item) => item.status === "CONFIRMED").map((item) => item.decision_id);
  const missing = confirmedIds.filter((id) => !ledgerIds.includes(id));
  if (missing.length) throw new Error(`决策账本缺少 CP-P01 已确认决策: ${missing.join(", ")}`);
  const targetPath = repoRefToPath(targetRef, root);
  writeJsonAtomic(targetPath, ledger);
  state.decision_ledger_version = ledger.version;
  state.latest_output_ref = pathToRepoRef(targetPath, root);
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "VERSION_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "decision_ledger"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "prd-thinking", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(targetPath, root),
    details: { version: ledger.version, confirmed_decision_ids: confirmedIds }
  });
  return { status: "RECORDED", ledger_ref: pathToRepoRef(targetPath, root), version: ledger.version };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const ledgerArg = argVal(args, "--ledger");
  if (!taskId || !ledgerArg) {
    console.error("用法: record-confirmed-decisions.ts --task-id <id> --ledger <json>");
    process.exit(1);
  }
  const ledgerPath = path.isAbsolute(ledgerArg) ? ledgerArg : path.join(PROJECT_ROOT, ledgerArg);
  console.log(JSON.stringify(recordConfirmedDecisions(taskId, ledgerPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
