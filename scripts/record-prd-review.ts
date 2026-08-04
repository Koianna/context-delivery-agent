#!/usr/bin/env npx tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROJECT_ROOT, appendEvent, idempotencyKey, nowISO, readTaskState, uid, writeTaskState,
} from "./lib/config.js";
import type { PrdReviewOutput, PrdReviewTemplate } from "./lib/prd-types.js";
import { validatePrdReview } from "./validate-prd-output.js";
import { parseFrontmatter, pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";

export function recordPrdReview(taskId: string, templatePath: string, prdRef: string, root = PROJECT_ROOT) {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  if (state.current_state !== "PRD_REVIEWING") throw new Error(`当前状态 ${state.current_state} 不允许记录审核`);
  const prdPath = repoRefToPath(prdRef, root);
  const before = fs.readFileSync(prdPath, "utf-8");
  const document = parseFrontmatter(before);
  const template = readJson<PrdReviewTemplate>(templatePath);
  const review: PrdReviewOutput = {
    ...template,
    prd_sha256: crypto.createHash("sha256").update(document.body).digest("hex"),
  };
  const errors = validatePrdReview(review, prdRef, root);
  if (errors.length) throw new Error(`PRD 审核输出校验失败:\n${errors.join("\n")}`);
  const reportPath = path.join(root, "context-workspace/workspace/reports/prd-review.json");
  writeJsonAtomic(reportPath, review);
  const after = fs.readFileSync(prdPath, "utf-8");
  if (before !== after) throw new Error("prd-review 不得修改 PRD");

  state.latest_output_ref = pathToRepoRef(reportPath, root);
  state.skill_versions["prd-review"] = "0.2.0";
  state.prompt_versions["prd-review"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(), event_type: "SKILL_RESULT", task_id: taskId,
    request_id: `req_${uid()}`, idempotency_key: idempotencyKey(taskId, "prd_review"),
    timestamp: nowISO(), operator: "SYSTEM", current_state: state.current_state,
    previous_state: state.previous_state, skill_name: "prd-review", skill_version: "0.2.0",
    prompt_version: "0.2.0", artifact_ref: pathToRepoRef(reportPath, root),
    details: { reviewed_version: review.reviewed_prd_version, summary: review.summary }
  });
  return { status: "RECORDED", review_ref: pathToRepoRef(reportPath, root), summary: review.summary };
}

function main() {
  const args = process.argv.slice(2);
  const taskId = argVal(args, "--task-id");
  const templateArg = argVal(args, "--template");
  const prdRef = argVal(args, "--prd-ref");
  if (!taskId || !templateArg || !prdRef) {
    console.error("用法: record-prd-review.ts --task-id <id> --template <json> --prd-ref <repo-ref>");
    process.exit(1);
  }
  const templatePath = path.isAbsolute(templateArg) ? templateArg : path.join(PROJECT_ROOT, templateArg);
  console.log(JSON.stringify(recordPrdReview(taskId, templatePath, prdRef), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
