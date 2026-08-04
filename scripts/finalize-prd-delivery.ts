#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, getLatestConfirmation, idempotencyKey, nowISO,
  readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { ConfirmationRecord } from "./lib/types.js";
import type { PrdReviewOutput } from "./lib/prd-types.js";
import { validateDeliveryConfirmation } from "./lib/prd-guards.js";
import {
  parseFrontmatter, pathToRepoRef, readJson, renderFrontmatter, repoRefToPath, writeTextAtomic,
} from "./lib/repository.js";
import { validatePrdReview } from "./validate-prd-output.js";

export function validateFinalDeliveryArtifacts(
  confirmation: ConfirmationRecord | undefined,
  review: PrdReviewOutput,
  prdRef: string,
  root = PROJECT_ROOT
): string[] {
  const errors = validateDeliveryConfirmation(confirmation, confirmation?.task_id);
  const payload = confirmation?.items[0];
  if (payload?.accepted_review_id !== review.review_id) {
    errors.push("CP-P03 接受的 review_id 与审核报告不一致");
  }
  errors.push(...validatePrdReview(review, prdRef, root));

  const acceptedP2Ids = new Set(
    Array.isArray(payload?.accepted_p2_issue_ids) ? payload.accepted_p2_issue_ids as string[] : []
  );
  const reviewP2Ids = review.issues
    .filter((issue) => issue.severity === "P2")
    .map((issue) => issue.issue_id);
  if (reviewP2Ids.some((id) => !acceptedP2Ids.has(id)) || acceptedP2Ids.size !== reviewP2Ids.length) {
    errors.push("CP-P03 的 P2 处理清单与审核报告不一致");
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const prdRef = argVal(args, "--prd-ref");
  const reviewArg = argVal(args, "--review");
  if (!taskId || !prdRef || !reviewArg) {
    console.error("用法: finalize-prd-delivery.ts --task-id <id> --prd-ref <repo-ref> --review <json>");
    process.exit(1);
  }
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "WAITING_REVIEW_DECISION") throw new Error(`当前状态 ${state.current_state} 不允许交付定稿`);
  const confirmation = getLatestConfirmation(taskId, "WAITING_REVIEW_DECISION", "REVIEW_DISPOSITION");
  const reviewPath = path.isAbsolute(reviewArg) ? reviewArg : path.join(PROJECT_ROOT, reviewArg);
  const review = readJson<PrdReviewOutput>(reviewPath);
  const guardErrors = validateFinalDeliveryArtifacts(confirmation, review, prdRef);
  if (guardErrors.length) throw new Error(`PRD 交付校验失败:\n${guardErrors.join("\n")}`);
  const prdPath = repoRefToPath(prdRef);
  const document = parseFrontmatter(fs.readFileSync(prdPath, "utf-8"));
  const metadata: Record<string, string | string[] | null> = {
    ...document.metadata,
    status: "delivered",
    review_ref: pathToRepoRef(reviewPath),
    delivered_at: nowISO(),
  };
  writeTextAtomic(prdPath, renderFrontmatter(metadata, document.body));
  state.latest_output_ref = prdRef;
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "VERSION_CREATED", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "prd_delivery"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: null, skill_version: null,
    prompt_version: null, artifact_ref: prdRef,
    details: { version: review.reviewed_prd_version, review_id: review.review_id, status: "delivered" }
  });
  console.log(JSON.stringify({ status: "FINALIZED", prd_ref: prdRef, version: review.reviewed_prd_version }, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
