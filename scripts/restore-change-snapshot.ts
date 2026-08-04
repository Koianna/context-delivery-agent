#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, getLatestConfirmation, idempotencyKey, nowISO,
  readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import { validateChangeCancellation } from "./lib/change-guards.js";
import { restoreChangeSnapshot } from "./lib/change-snapshot.js";
import type { ChangeSnapshotManifest } from "./lib/change-types.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";

export function restoreCancelledChange(taskId: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "WAITING_REPLAN_CONFIRM") throw new Error(`当前状态 ${state.current_state} 不允许取消变更`);
  const confirmation = getLatestConfirmation(taskId, "WAITING_REPLAN_CONFIRM", "REPLAN_APPROVAL");
  const guardErrors = validateChangeCancellation(confirmation, taskId);
  if (guardErrors.length) throw new Error(`取消变更校验失败:\n${guardErrors.join("\n")}`);
  const snapshotRef = confirmation!.items[0].snapshot_ref as string;
  const result = restoreChangeSnapshot(snapshotRef, root);
  const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(snapshotRef, root));
  state.return_state = result.source_state;
  state.material_version = manifest.baseline_versions.material_version;
  state.context_version = manifest.baseline_versions.context_version;
  state.decision_ledger_version = manifest.baseline_versions.decision_ledger_version;
  state.prd_version = manifest.baseline_versions.prd_version;
  state.plan_version = manifest.baseline_versions.plan_version;
  state.latest_output_ref = snapshotRef;
  writeTaskState(state);
  const reportPath = path.join(root, "context-workspace/workspace/reports/change-restore.json");
  writeJsonAtomic(reportPath, {
    task_id: taskId,
    change_id: manifest.change_id,
    snapshot_ref: snapshotRef,
    status: result.status,
    restored_refs: result.restored_refs,
    return_state: result.source_state,
    restored_at: nowISO(),
  });
  appendEvent({
    event_id: uid(), event_type: "TASK_RESUMED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "restore_change_snapshot"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: null, skill_version: null,
    prompt_version: null, artifact_ref: pathToRepoRef(reportPath, root),
    details: { snapshot_ref: snapshotRef, status: result.status, restored_refs: result.restored_refs }
  });
  return { ...result, report_ref: pathToRepoRef(reportPath, root) };
}

function main() {
  const taskId = argVal(process.argv.slice(2), "--task-id");
  if (!taskId) {
    console.error("用法: restore-change-snapshot.ts --task-id <id>");
    process.exit(1);
  }
  console.log(JSON.stringify(restoreCancelledChange(taskId), null, 2));
}

function argVal(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
if (require.main === module) main();
