#!/usr/bin/env npx tsx
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readPendingConfirmations,
  readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { PrdWriteOutput } from "./lib/prd-types.js";
import { authorizePrdWrite, writePrdArtifactFile } from "./lib/prd-write.js";
import { savePrdRecoverySnapshot } from "./lib/prd-recovery.js";
import {
  pathToRepoRef, readJson,
} from "./lib/repository.js";

export function applyPrdArtifact(taskId: string, outputPath: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  const confirmations = readPendingConfirmations();
  if (!state || state.task_id !== taskId || !confirmations || confirmations.task_id !== taskId) {
    throw new Error(`任务 ${taskId} 的状态或确认记录不存在`);
  }
  const output = readJson<PrdWriteOutput>(outputPath);
  const errors = authorizePrdWrite(state, confirmations.records, output, root);
  if (errors.length) throw new Error(`PRD 写入预检失败:\n${errors.join("\n")}`);

  const artifact = output.prd_artifact;
  const createdAt = nowISO();
  const writeResult = writePrdArtifactFile(output, root, createdAt);
  const { status, targetPath } = writeResult;
  const recovery = savePrdRecoverySnapshot(state, artifact, targetPath, root, createdAt);

  state.prd_version = artifact.version;
  state.latest_output_ref = pathToRepoRef(targetPath, root);
  state.skill_versions["prd-write"] = "0.2.0";
  state.prompt_versions["prd-write"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "ARTIFACT_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, `prd_${artifact.phase}`),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "prd-write", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(targetPath, root),
    details: {
      phase: artifact.phase,
      version: artifact.version,
      status,
      prd_sha256: recovery.file_sha256,
      prd_body_sha256: recovery.body_sha256,
      recovery_manifest_ref: recovery.manifest_ref,
      recovery_snapshot_ref: recovery.snapshot_ref,
    }
  });
  return {
    status,
    phase: artifact.phase,
    version: artifact.version,
    artifact_ref: pathToRepoRef(targetPath, root),
    recovery_manifest_ref: recovery.manifest_ref,
    recovery_snapshot_ref: recovery.snapshot_ref,
  };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const outputArg = argVal(args, "--output");
  if (!taskId || !outputArg) {
    console.error("用法: apply-prd-artifact.ts --task-id <id> --output <prd-write-output.json>");
    process.exit(1);
  }
  const outputPath = path.isAbsolute(outputArg) ? outputArg : path.join(PROJECT_ROOT, outputArg);
  console.log(JSON.stringify(applyPrdArtifact(taskId, outputPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
