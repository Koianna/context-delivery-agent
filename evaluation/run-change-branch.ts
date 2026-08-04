#!/usr/bin/env npx tsx
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import {
  validateAppliedReplan, validateChangeCancellation, validateReplanApproval,
} from "../scripts/lib/change-guards.js";
import {
  createChangeSnapshot, restoreChangeSnapshot, sha256Buffer,
} from "../scripts/lib/change-snapshot.js";
import type {
  ChangeAnalysisOutput, ChangeRequestInput, ReplanOutput,
} from "../scripts/lib/change-types.js";
import type { ConfirmationRecord, TaskState } from "../scripts/lib/types.js";
import type { PrdWriteOutput } from "../scripts/lib/prd-types.js";
import { authorizePrdWrite, writePrdArtifactFile } from "../scripts/lib/prd-write.js";
import { parseFrontmatter, readJson, repoRefToPath, writeJsonAtomic } from "../scripts/lib/repository.js";
import { validatePrdWrite } from "../scripts/validate-prd-output.js";
import {
  validateChangeAnalysis, validateChangeInput, validateReplan,
} from "../scripts/validate-change-output.js";

interface CaseResult { case_id: string; passed: boolean; detail: string }
const results: CaseResult[] = [];
const check = (caseId: string, passed: boolean, detail: string) => results.push({ case_id: caseId, passed, detail });

const caseRoot = path.join(PROJECT_ROOT, "case-data/help-center-search/change");
const input = readJson<ChangeRequestInput>(path.join(caseRoot, "change-request.input.json"));
const analysis = readJson<ChangeAnalysisOutput>(path.join(caseRoot, "expected-outputs/change-impact.analysis.json"));
const replan = readJson<ReplanOutput>(path.join(caseRoot, "expected-outputs/change-impact.replan.json"));
const approvalPayload = readJson<Record<string, unknown>>(path.join(caseRoot, "expected-decisions/change-r01.approval.json"));
const revision = readJson<PrdWriteOutput>(path.join(caseRoot, "expected-outputs/prd-write.revision-details.output.json"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "change-branch-eval-"));

try {
  seedTempRepository(tempRoot);
  const baselineHashes = artifactHashes(input, tempRoot);
  const inputErrors = validateChangeInput(input, tempRoot);
  const firstSnapshot = createChangeSnapshot(input, "eval-change", tempRoot, "2026-08-04T14:01:00+08:00");
  check("CHG-01", inputErrors.length === 0 && firstSnapshot.manifest.artifacts.length === 6, inputErrors.join("; ") || "输入和六个快照产物通过校验");

  const secondSnapshot = createChangeSnapshot(input, "eval-change", tempRoot, "2026-08-04T14:02:00+08:00");
  check("CHG-02", firstSnapshot.status === "CREATED" && secondSnapshot.status === "UNCHANGED", "相同基线重复创建快照保持幂等");

  const analysisErrors = validateChangeAnalysis(input, analysis, tempRoot);
  check("CHG-03", analysisErrors.length === 0 && analysis.change_classification.change_type === "DETAIL_RULE_CHANGE" && analysis.recommended_return_state === "PRD_DRAFTING_DETAILS", analysisErrors.join("; ") || "规则级变化返回 DETAILS");

  const affectedPrd = analysis.affected_items.find((item) => item.item_id === "affected-prd-detail-rule");
  const affectedReview = analysis.affected_items.find((item) => item.item_id === "affected-review");
  check("CHG-04", !!affectedPrd?.locations.includes("10. 验收标准") && affectedReview?.impact_type === "REVIEW_INVALIDATED", "影响范围覆盖规则、验收和失效审核报告");

  const preservedCore = analysis.unaffected_items.find((item) => item.item_id === "preserved-prd-core");
  const preservedDecisions = analysis.unaffected_items.find((item) => item.item_id === "preserved-decisions");
  check("CHG-05", !!preservedCore?.locations.includes("5. 本期范围与核心流程") && !!preservedDecisions, "明确保留 PRD 主体和已确认决策");

  const analysisReportPath = path.join(tempRoot, "context-workspace/workspace/reports/change-impact.json");
  writeJsonAtomic(analysisReportPath, analysis);
  check("CHG-06", hashesEqual(baselineHashes, artifactHashes(input, tempRoot)), "影响分析只写报告，未修改任何业务产物");

  const replanErrors = validateReplan(analysis, replan, tempRoot);
  check("CHG-07", replanErrors.length === 0 && replan.plan.steps[0]?.state === "PRD_DRAFTING_DETAILS" && !replan.plan.required_confirmations.includes("CP-P02"), replanErrors.join("; ") || "重规划沿用分析 hash，只安排必要步骤和确认点");

  const planPath = path.join(tempRoot, "context-workspace/workspace/plans/help-center-search-replan.json");
  writeJsonAtomic(planPath, replan);
  const approval = makeConfirmation("APPROVED", "APPROVE_REPLAN", approvalPayload);
  const noConfirmationErrors = validateReplanApproval(undefined, "eval-change", "PRD_DRAFTING_DETAILS", tempRoot);
  const wrongTargetErrors = validateReplanApproval(approval, "eval-change", "PRD_DRAFTING_CORE", tempRoot);
  const tamperedPlan: ReplanOutput = {
    ...replan,
    plan: { ...replan.plan, steps: replan.plan.steps.map((step, index) => index === 0 ? { ...step, action: "未确认的扩大范围" } : step) },
  };
  writeJsonAtomic(planPath, tamperedPlan);
  const tamperedErrors = validateReplanApproval(approval, "eval-change", "PRD_DRAFTING_DETAILS", tempRoot);
  writeJsonAtomic(planPath, replan);
  writeJsonAtomic(analysisReportPath, { ...analysis, unaffected_items: [] });
  const tamperedAnalysisErrors = validateReplanApproval(approval, "eval-change", "PRD_DRAFTING_DETAILS", tempRoot);
  writeJsonAtomic(analysisReportPath, analysis);
  check(
    "CHG-08",
    noConfirmationErrors.length > 0
      && wrongTargetErrors.some((error) => error.includes("目标") || error.includes("返回节点"))
      && tamperedErrors.some((error) => error.includes("hash"))
      && tamperedAnalysisErrors.some((error) => error.includes("影响报告 hash")),
    "缺少 CP-R01、目标不一致、计划或影响报告漂移时阻止返回业务节点"
  );

  const appliedState = makeState("WAITING_REPLAN_CONFIRM", 1);
  appliedState.plan_version = "0.2.0";
  appliedState.return_state = "PRD_DRAFTING_DETAILS";
  const appliedErrors = validateAppliedReplan(approval, appliedState, "PRD_DRAFTING_DETAILS", 3, tempRoot);
  const confirmedDecisions = ["decision_solution", "decision_boundary", "decision_owner", "decision_validation"];
  const revisionContractErrors = validatePrdWrite(revision, confirmedDecisions, tempRoot);
  const revisionAuthorization = authorizePrdWrite(
    { ...appliedState, current_state: "PRD_DRAFTING_DETAILS" },
    [approval],
    revision,
    tempRoot
  );
  const beforeRevision = parseFrontmatter(fs.readFileSync(repoRefToPath(revision.prd_artifact.markdown_ref, tempRoot), "utf-8"));
  const revisionResult = writePrdArtifactFile(revision, tempRoot, "2026-08-04T14:12:00+08:00");
  const afterRevision = parseFrontmatter(fs.readFileSync(repoRefToPath(revision.prd_artifact.markdown_ref, tempRoot), "utf-8"));
  const coreUnchanged = beforeRevision.body.split("## 6. 功能规则")[0] === afterRevision.body.split("## 6. 功能规则")[0];
  check(
    "CHG-09",
    appliedErrors.length === 0 && revisionContractErrors.length === 0 && revisionAuthorization.length === 0
      && revisionResult.status === "UPDATED" && afterRevision.metadata.version === "0.2.1" && coreUnchanged,
    [...appliedErrors, ...revisionContractErrors, ...revisionAuthorization].join("; ") || "CP-R01 授权 0.2.1 DETAILS 局部修订并保留 PRD 主体"
  );
  restoreChangeSnapshot(analysis.snapshot_ref, tempRoot);

  const overLimit = makeState("WAITING_REPLAN_CONFIRM", 4);
  overLimit.plan_version = "0.2.0";
  overLimit.return_state = "PRD_DRAFTING_DETAILS";
  check("CHG-10", validateAppliedReplan(approval, overLimit, "PRD_DRAFTING_DETAILS", 3, tempRoot).some((error) => error.includes("上限")), "超过三次重规划时阻断继续执行");

  const unknownAnalysis: ChangeAnalysisOutput = {
    ...analysis,
    change_classification: { change_type: "UNKNOWN", is_material_change: false, confidence: 0.4 },
    affected_items: [],
    recommended_return_state: null,
  };
  check("CHG-11", validateChangeAnalysis(input, unknownAnalysis, tempRoot).length === 0, "无法判断的变化不自动选择返回节点");

  const prdPath = repoRefToPath("repo://context-workspace/workspace/prd/help-center-search.md", tempRoot);
  fs.appendFileSync(prdPath, "\n未授权修改\n", "utf-8");
  const cancelled = makeConfirmation("CANCELLED", "CANCEL_CHANGE", {
    change_id: input.change_request.change_id,
    snapshot_ref: analysis.snapshot_ref,
    reason: "取消本次变更并恢复原版本",
  });
  const restoreResult = restoreChangeSnapshot(analysis.snapshot_ref, tempRoot);
  const cancelErrors = validateChangeCancellation(cancelled, "eval-change", "DELIVERED", tempRoot);
  check("CHG-12", restoreResult.status === "RESTORED" && cancelErrors.length === 0 && hashesEqual(baselineHashes, artifactHashes(input, tempRoot)), cancelErrors.join("; ") || "取消变更后全部业务产物恢复为快照原字节");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const passed = results.filter((item) => item.passed).length;
const report = {
  evaluation_id: "change-branch-help-center-search",
  eval_set_version: "0.4.0",
  git_commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(),
  skill_versions: { "change-impact": "0.2.0" },
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--write-result")) {
  const output = path.join(PROJECT_ROOT, "evaluation/results/change-branch.latest.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf-8");
}
if (passed !== results.length) process.exit(1);

function seedTempRepository(root: string) {
  for (const ref of input.artifact_refs) {
    const source = repoRefToPath(ref, PROJECT_ROOT);
    const target = repoRefToPath(ref, root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const candidateRef = "repo://case-data/help-center-search/change/candidates/help-center-search.revision-details.md";
  const candidateTarget = repoRefToPath(candidateRef, root);
  fs.mkdirSync(path.dirname(candidateTarget), { recursive: true });
  fs.copyFileSync(repoRefToPath(candidateRef, PROJECT_ROOT), candidateTarget);
  const indexRef = "repo://context-workspace/context/INDEX.md";
  const indexTarget = repoRefToPath(indexRef, root);
  fs.mkdirSync(path.dirname(indexTarget), { recursive: true });
  fs.copyFileSync(repoRefToPath(indexRef, PROJECT_ROOT), indexTarget);
}

function artifactHashes(changeInput: ChangeRequestInput, root: string): Record<string, string> {
  return Object.fromEntries(changeInput.artifact_refs.map((ref) => [ref, sha256Buffer(fs.readFileSync(repoRefToPath(ref, root)))]));
}

function hashesEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function makeConfirmation(
  status: ConfirmationRecord["status"],
  resolution: string,
  payload: Record<string, unknown>
): ConfirmationRecord {
  return {
    confirmation_id: `confirm-${resolution}`, confirmation_type: "REPLAN_APPROVAL", task_id: "eval-change",
    current_state: "WAITING_REPLAN_CONFIRM", source_state: "REPLANNING",
    return_state: (payload.approved_return_state as ConfirmationRecord["return_state"]) ?? "DELIVERED",
    title: "确认重规划方案", items: [{ ...payload, approval_status: status === "APPROVED" ? "APPROVED" : "REJECTED" }],
    allowed_actions: [resolution], status, resolved_by: "USER", resolved_at: "2026-08-04T14:10:00+08:00", resolution,
  };
}

function makeState(currentState: TaskState["current_state"], replanCount: number): TaskState {
  return {
    task_id: "eval-change", project_id: "help-center-search", session_id: "eval-session", task_mode: "CHANGE",
    current_state: currentState, previous_state: "REPLANNING", return_state: "DELIVERED",
    task_goal: "修改目标内容失效规则", completed_steps: [], pending_confirmation: null,
    material_version: "0.2.0", context_version: "0.1.1", decision_ledger_version: "0.2.0",
    prd_version: "0.2.0", plan_version: "0.1.0", latest_output_ref: null, retry_count: 0,
    replan_count: replanCount, error_info: null, git_commit: null,
    prompt_versions: {}, skill_versions: {}, created_at: "2026-08-04T14:00:00+08:00", updated_at: "2026-08-04T14:00:00+08:00",
  };
}
