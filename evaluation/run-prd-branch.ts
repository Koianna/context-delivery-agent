#!/usr/bin/env npx tsx
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import type { ConfirmationRecord, TaskState } from "../scripts/lib/types.js";
import type {
  PrdReviewOutput, PrdReviewTemplate, PrdThinkingOutput, PrdWriteOutput,
} from "../scripts/lib/prd-types.js";
import {
  validateCoreConfirmation, validateDeliveryConfirmation, validatePrdEntryConfirmation,
} from "../scripts/lib/prd-guards.js";
import { validateFinalDeliveryArtifacts } from "../scripts/finalize-prd-delivery.js";
import { authorizePrdWrite, writePrdArtifactFile } from "../scripts/lib/prd-write.js";
import {
  parseFrontmatter, readJson, repoRefToPath,
} from "../scripts/lib/repository.js";
import {
  validatePrdReview, validatePrdThinking, validatePrdWrite,
} from "../scripts/validate-prd-output.js";

interface CaseResult { case_id: string; passed: boolean; detail: string }
const results: CaseResult[] = [];
const check = (caseId: string, passed: boolean, detail: string) => results.push({ case_id: caseId, passed, detail });

const caseRoot = path.join(PROJECT_ROOT, "evaluation/fixtures/prd");
const thinking = readJson<PrdThinkingOutput>(path.join(caseRoot, "expected-outputs/prd-thinking.output.json"));
const ledger = readJson<{ decisions: Array<{ decision_id: string; status: string }> }>(path.join(caseRoot, "decision-ledger.confirmed.json"));
const confirmedIds = ledger.decisions.filter((item) => item.status === "CONFIRMED").map((item) => item.decision_id);
const core = readJson<PrdWriteOutput>(path.join(caseRoot, "expected-outputs/prd-write.core.output.json"));
const details = readJson<PrdWriteOutput>(path.join(caseRoot, "expected-outputs/prd-write.details.output.json"));
const p01Payload = readJson<Record<string, unknown>>(path.join(caseRoot, "expected-decisions/prd-p01.approval.json"));
const p02Payload = readJson<Record<string, unknown>>(path.join(caseRoot, "expected-decisions/prd-p02.approval.json"));
const p03Payload = readJson<Record<string, unknown>>(path.join(caseRoot, "expected-decisions/prd-p03.approval.json"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prd-branch-eval-"));
seedTempRepository(tempRoot);

const thinkingErrors = validatePrdThinking(thinking, tempRoot);
check("PRD-01", thinkingErrors.length === 0 && !(thinking as unknown as Record<string, unknown>).prd_artifact, thinkingErrors.join("; ") || "写前分析有来源且未输出 PRD 正文");

const pendingBlocking = thinking.decision_ledger.filter((item) => item.is_blocking && item.status === "PENDING");
check("PRD-02", pendingBlocking.length === 2 && thinking.writable_assessment.status === "NEEDS_CONFIRMATION", "两个阻塞决策未确认时保持 NEEDS_CONFIRMATION");

const validP01 = makeConfirmation("DECISION_AND_WRITABLE_STATUS", "WAITING_DECISION_CONFIRM", "CONFIRM_WRITABLE", p01Payload);
const invalidP01 = makeConfirmation(
  "DECISION_AND_WRITABLE_STATUS", "WAITING_DECISION_CONFIRM", "CONFIRM_WRITABLE",
  { ...p01Payload, writable_status: false }
);
check("PRD-03", validatePrdEntryConfirmation(invalidP01, "eval-prd").length > 0, "writable_status=false 时 CP-P01 拒绝准入");

const coreContractErrors = validatePrdWrite(core, confirmedIds, tempRoot);
try {
  const coreState = makeState("PRD_DRAFTING_CORE");
  const coreAuth = authorizePrdWrite(coreState, [validP01], core, tempRoot);
  check("PRD-04", validatePrdEntryConfirmation(validP01, "eval-prd").length === 0 && coreAuth.length === 0 && coreContractErrors.length === 0, coreAuth.join("; ") || "CP-P01 与 CORE 契约通过");

  const coreFirst = writePrdArtifactFile(core, tempRoot, "2026-08-04T11:30:00+08:00");
  const coreSecond = writePrdArtifactFile(core, tempRoot, "2026-08-04T11:30:00+08:00");
  const targetPath = repoRefToPath(core.prd_artifact.markdown_ref, tempRoot);
  const coreDocument = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
  check("PRD-05", coreFirst.status === "CREATED" && coreSecond.status === "UNCHANGED" && coreDocument.metadata.version === "0.1.0", "CORE 创建 0.1.0，重复执行不产生新版本");

  check("PRD-06", !coreDocument.body.includes("## 10. 验收标准") && !coreDocument.body.includes("## 7. 角色与权限"), "CORE 未提前展开权限和完整验收细节");

  const detailsState = makeState("PRD_DRAFTING_DETAILS");
  const noP02 = authorizePrdWrite(detailsState, [validP01], details, tempRoot);
  check("PRD-07", noP02.some((error) => error.includes("CP-P02")), "没有 CP-P02 时 DETAILS 写入被拒绝");

  const validP02 = makeConfirmation("SCOPE_AND_CORE_FLOW", "WAITING_SCOPE_CONFIRM", "APPROVE_CORE", p02Payload);
  const detailsContractErrors = validatePrdWrite(details, confirmedIds, tempRoot);
  const detailsAuth = authorizePrdWrite(detailsState, [validP01, validP02], details, tempRoot);
  const prd08Errors = [...validateCoreConfirmation(validP02, "eval-prd"), ...detailsAuth, ...detailsContractErrors];
  check("PRD-08", prd08Errors.length === 0, prd08Errors.join("; ") || "CP-P02 与 DETAILS 契约通过");

  const detailsFirst = writePrdArtifactFile(details, tempRoot, "2026-08-04T11:50:00+08:00");
  const detailsSecond = writePrdArtifactFile(details, tempRoot, "2026-08-04T11:50:00+08:00");
  const detailsDocument = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
  check("PRD-09", detailsFirst.status === "UPDATED" && detailsSecond.status === "UNCHANGED" && detailsDocument.metadata.version === "0.2.0" && detailsDocument.body.includes("产品目标"), "DETAILS 更新到 0.2.0、保留主体且幂等");

  const reviewTemplate = readJson<PrdReviewTemplate>(path.join(caseRoot, "prd-review.template.json"));
  const beforeHash = crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
  const review: PrdReviewOutput = {
    ...reviewTemplate,
    prd_sha256: crypto.createHash("sha256").update(detailsDocument.body).digest("hex"),
  };
  const reviewErrors = validatePrdReview(review, details.prd_artifact.markdown_ref, tempRoot);
  const afterHash = crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
  check("PRD-10", reviewErrors.length === 0 && beforeHash === afterHash && review.summary.p2_count === 2, reviewErrors.join("; ") || "审核计数正确且未修改 PRD");

  const validP03 = makeConfirmation("REVIEW_DISPOSITION", "WAITING_REVIEW_DECISION", "ACCEPT_AND_DELIVER", p03Payload);
  const blockedP03 = makeConfirmation(
    "REVIEW_DISPOSITION", "WAITING_REVIEW_DECISION", "ACCEPT_AND_DELIVER",
    { ...p03Payload, review_summary: { p0_count: 0, p1_count: 1, p2_count: 1, recommendation: "FIX_BEFORE_DELIVERY" } }
  );
  const incompleteP2 = makeConfirmation(
    "REVIEW_DISPOSITION", "WAITING_REVIEW_DECISION", "ACCEPT_AND_DELIVER",
    { ...p03Payload, accepted_p2_issue_ids: ["issue_target_unavailable"] }
  );
  const validDeliveryErrors = validateFinalDeliveryArtifacts(validP03, review, details.prd_artifact.markdown_ref, tempRoot);
  fs.appendFileSync(targetPath, "\n审核后未授权修改\n", "utf-8");
  const staleReviewErrors = validateFinalDeliveryArtifacts(validP03, review, details.prd_artifact.markdown_ref, tempRoot);
  check(
    "PRD-11",
    validDeliveryErrors.length === 0
      && validateDeliveryConfirmation(blockedP03, "eval-prd").some((error) => error.includes("P0/P1"))
      && validateDeliveryConfirmation(incompleteP2, "eval-prd").some((error) => error.includes("P2"))
      && staleReviewErrors.some((error) => error.includes("hash")),
    "交付门禁阻断 P0/P1、未逐项处置 P2 和审核后正文变化"
  );

  check("PRD-12", core.prd_artifact.markdown_ref === details.prd_artifact.markdown_ref && core.prd_artifact.version === details.prd_artifact.previous_version && review.reviewed_prd_version === details.prd_artifact.version, "CORE、DETAILS、REVIEW 使用稳定路径和连续版本");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const passed = results.filter((item) => item.passed).length;
const report = {
  evaluation_id: "prd-branch-generic-fixture",
  eval_set_version: "0.3.0",
  git_commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(),
  skill_versions: { "prd-thinking": "0.2.0", "prd-write": "0.2.0", "prd-review": "0.2.0" },
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--write-result")) {
  const output = path.join(PROJECT_ROOT, "evaluation/results/prd-branch.latest.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf-8");
}
if (passed !== results.length) process.exit(1);

function seedTempRepository(root: string) {
  for (const name of ["product-work.core.md", "product-work.details.md"]) {
    const source = path.join(caseRoot, "candidates", name);
    const target = path.join(root, "evaluation/fixtures/prd/candidates", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.mkdirSync(path.join(root, "context-workspace/workspace/prd"), { recursive: true });
  const refs = [
    ["evaluation/fixtures/seed-context/current-state.md", "context-workspace/context/product-work/product/current-state.md"],
    ["evaluation/fixtures/seed-context/solution.md", "context-workspace/context/product-work/product/solution.md"],
    ["evaluation/fixtures/seed-context/boundary.md", "context-workspace/context/product-work/business-rules/boundary.md"],
    ["evaluation/fixtures/source-materials/用户反馈.md", "context-workspace/drafts/product-work/用户反馈.md"],
  ];
  for (const [source, target] of refs) {
    const targetPath = path.join(root, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, source), targetPath);
  }
  const decisionPath = path.join(root, "context-workspace/workspace/decisions/open-questions.md");
  fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
  fs.writeFileSync(decisionPath, "# 待确认事项\n\n本夹具只验证来源引用存在性。\n", "utf-8");
  const ledgerSource = path.join(root, "evaluation/fixtures/prd/decision-ledger.confirmed.json");
  fs.mkdirSync(path.dirname(ledgerSource), { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, "evaluation/fixtures/prd/decision-ledger.confirmed.json"), ledgerSource);
}

function makeState(currentState: TaskState["current_state"]): TaskState {
  return {
    task_id: "eval-prd", project_id: "product-work", session_id: "eval-session", task_mode: "PRD",
    current_state: currentState, previous_state: null, return_state: null, task_goal: "准备项目需求 PRD",
    completed_steps: [], pending_confirmation: null, material_version: "0.2.0", context_version: "0.1.1",
    decision_ledger_version: "0.2.0", prd_version: "0.0.0", plan_version: "0.1.0",
    latest_output_ref: null, retry_count: 0, replan_count: 0, error_info: null, git_commit: null,
    prompt_versions: {}, skill_versions: {}, created_at: "2026-08-04T11:00:00+08:00", updated_at: "2026-08-04T11:00:00+08:00"
  };
}

function makeConfirmation(
  type: ConfirmationRecord["confirmation_type"],
  state: ConfirmationRecord["current_state"],
  resolution: string,
  payload: Record<string, unknown>
): ConfirmationRecord {
  return {
    confirmation_id: `confirm-${type}`, confirmation_type: type, task_id: "eval-prd",
    current_state: state, source_state: null, return_state: null, title: type,
    items: [{ ...payload, approval_status: "APPROVED" }], allowed_actions: [resolution],
    status: "APPROVED", resolved_by: "USER", resolved_at: "2026-08-04T11:20:00+08:00", resolution,
  };
}
