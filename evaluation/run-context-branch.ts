#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import type { ContextAnalysisOutput, MaterialIngestInput, MaterialIngestOutput } from "../scripts/lib/context-types.js";
import { authorizeContextWrite } from "../scripts/lib/context-write.js";
import type { ConfirmationRecord, TaskState } from "../scripts/lib/types.js";
import { createVersion } from "../scripts/create-version.js";
import { parseFrontmatter, readJson, writeTextAtomic } from "../scripts/lib/repository.js";
import { updateIndex } from "../scripts/update-index.js";
import { validateContextAnalysis, validateMaterialOutput } from "../scripts/validate-skill-output.js";

interface CaseResult { case_id: string; passed: boolean; detail: string }
const results: CaseResult[] = [];

function check(caseId: string, condition: boolean, detail: string) {
  results.push({ case_id: caseId, passed: condition, detail });
}

const caseRoot = path.join(PROJECT_ROOT, "evaluation/fixtures");
const input = readJson<MaterialIngestInput>(path.join(caseRoot, "material-ingest.input.json"));
const material = readJson<MaterialIngestOutput>(path.join(caseRoot, "expected-outputs/material-ingest.output.json"));
const analysis = readJson<ContextAnalysisOutput>(path.join(caseRoot, "expected-outputs/context-maintain.analysis.json"));

const materialErrors = validateMaterialOutput(input, material);
check("CTX-01", materialErrors.length === 0, materialErrors.join("; ") || "全部材料、证据和计数通过校验");

const analysisErrors = validateContextAnalysis(material, analysis);
check("CTX-02", analysisErrors.length === 0, analysisErrors.join("; ") || "Context 分析契约通过校验");

  const feedbackItems = material.information_items.filter((item) => item.source_refs.includes("src_feedback_202607"));
check("CTX-03", feedbackItems.every((item) => item.target_layer === "DRAFTS"), "缺少来源负责人的反馈材料未提升可信层");

const conflictIds = new Set((analysis.conflicts as Array<{ conflict_id: string }>).map((item) => item.conflict_id));
check("CTX-04", conflictIds.has("conflict_solution_001") && conflictIds.has("conflict_boundary_001"), "识别方案与范围两类冲突");

const stableActions = new Set(["PROMOTE_TO_CONTEXT", "UPDATE_CONTEXT", "MARK_SUPERSEDED", "ARCHIVE"]);
const itemMap = new Map(material.information_items.map((item) => [item.item_id, item]));
const noUnconfirmedPromotion = analysis.update_proposals
  .filter((proposal) => stableActions.has(proposal.action))
  .every((proposal) => itemMap.get(proposal.item_id)?.maturity !== "UNCONFIRMED");
check("CTX-05", noUnconfirmedPromotion, "未确认信息没有稳定 Context 写入 proposal");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-branch-eval-"));
try {
  seedTempRepository(tempRoot);
  const proposal = analysis.update_proposals.find((item) => item.proposal_id === "proposal_solution");
  if (!proposal) throw new Error("缺少 proposal_solution");
  const state = makeTaskState("CONTEXT_MAINTAINING");
  const approved = makeConfirmation(proposal.proposal_id);

  const deniedWithoutConfirmation = authorizeContextWrite({ taskState: state, confirmations: [], proposal, root: tempRoot });
  const rejectedAfterApproval: ConfirmationRecord = {
    ...approved,
    confirmation_id: "confirm-eval-newer-rejected",
    status: "REJECTED",
    items: [{ proposal_id: proposal.proposal_id, approval_status: "REJECTED" }],
    resolution: "REJECT_ALL",
  };
  const staleApproval = authorizeContextWrite({ taskState: state, confirmations: [approved, rejectedAfterApproval], proposal, root: tempRoot });
  check(
    "CTX-06",
    deniedWithoutConfirmation.some((error) => error.includes("CP-C01")) && staleApproval.some((error) => error.includes("CP-C01")),
    "无授权或最新确认拒绝时写入均被拒绝"
  );

  const wrongState = authorizeContextWrite({ taskState: makeTaskState("CONTEXT_ANALYZING"), confirmations: [approved], proposal, root: tempRoot });
  check("CTX-07", wrongState.some((error) => error.includes("当前状态")), "非维护状态写入被拒绝");

  const badBase = { ...proposal, base_version: "0.9.0" };
  const baseErrors = authorizeContextWrite({ taskState: state, confirmations: [approved], proposal: badBase, root: tempRoot });
  check("CTX-08", baseErrors.some((error) => error.includes("基线版本冲突")), "错误基线版本写入被拒绝");

  const authorized = authorizeContextWrite({ taskState: state, confirmations: [approved], proposal, root: tempRoot });
  check("CTX-09", authorized.length === 0, authorized.join("; ") || "已批准 proposal 通过写入预检");

  const first = createVersion({
    targetRef: proposal.target_ref!, contentRef: proposal.content_ref!, expectedVersion: proposal.base_version!,
    sourceRefs: proposal.source_refs, confirmedAt: "2026-08-04T10:30:00+08:00", root: tempRoot
  });
  const second = createVersion({
    targetRef: proposal.target_ref!, contentRef: proposal.content_ref!, expectedVersion: proposal.base_version!,
    sourceRefs: proposal.source_refs, confirmedAt: "2026-08-04T10:30:00+08:00", root: tempRoot
  });
  const retryAuthorization = authorizeContextWrite({ taskState: state, confirmations: [approved], proposal, root: tempRoot });
  check("CTX-10", first.status === "CREATED" && second.status === "UNCHANGED" && first.version === second.version && retryAuthorization.length === 0, "中断重试识别已落地内容，不创建新版本");

  const firstIndex = updateIndex(tempRoot, "2026-08-04", "product-work");
  const secondIndex = updateIndex(tempRoot, "2026-08-04", "product-work");
  check("CTX-11", firstIndex.entry_count === 3 && secondIndex.status === "UNCHANGED", "索引包含全部稳定 Context 且重复更新幂等");

  const archived = createVersion({
    targetRef: proposal.target_ref!, contentRef: proposal.target_ref!, expectedVersion: first.version,
    sourceRefs: proposal.source_refs, confirmedAt: "2026-08-04T11:00:00+08:00", action: "ARCHIVE", root: tempRoot,
  });
  const archivedIndex = updateIndex(tempRoot, "2026-08-04", "product-work");
  const archivedDocument = parseFrontmatter(fs.readFileSync(path.join(tempRoot, "context-workspace/context/product-work/product/solution.md"), "utf-8"));
  check("CTX-12", archived.status === "CREATED" && archivedIndex.entry_count === 2 && archivedDocument.metadata.status === "archived", "归档稳定 Context 后保留文件并从索引隐藏");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const passed = results.filter((result) => result.passed).length;
const commit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
const report = {
  evaluation_id: "context-branch-generic-fixture",
  eval_set_version: "0.2.0",
  git_commit: commit,
  skill_versions: { "material-ingest": "0.2.0", "context-maintain": "0.2.0" },
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--write-result")) {
  const outputPath = path.join(PROJECT_ROOT, "evaluation/results/context-branch.latest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
}
if (passed !== results.length) process.exit(1);

function seedTempRepository(root: string) {
  const mapping = [
    ["seed-context/current-state.md", "context-workspace/context/product-work/product/current-state.md"],
    ["seed-context/solution.md", "context-workspace/context/product-work/product/solution.md"],
    ["seed-context/boundary.md", "context-workspace/context/product-work/business-rules/boundary.md"],
    ["proposed-context/solution.md", "evaluation/fixtures/proposed-context/solution.md"],
    ["proposed-context/boundary.md", "evaluation/fixtures/proposed-context/boundary.md"]
  ];
  for (const [from, to] of mapping) {
    const source = path.join(caseRoot, from);
    const target = path.join(root, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  writeTextAtomic(path.join(root, "context-workspace/context/product-work/INDEX.md"), "---\nversion: 0.1.0\nproject: product-work\n---\n\n# Context 索引\n");
}

function makeTaskState(currentState: TaskState["current_state"]): TaskState {
  return {
    task_id: "eval-task", project_id: "product-work", session_id: "eval-session", task_mode: "CONTEXT",
    current_state: currentState, previous_state: "WAITING_CONTEXT_CONFIRM", return_state: "CONTEXT_TASK_COMPLETED",
    task_goal: "整理材料", completed_steps: [], pending_confirmation: null, material_version: "0.2.0",
    context_version: "1.0.0", decision_ledger_version: "0.1.0", prd_version: "0.1.0", plan_version: "0.1.0",
    latest_output_ref: null, retry_count: 0, replan_count: 0, error_info: null, git_commit: null,
    prompt_versions: {}, skill_versions: {}, created_at: "2026-08-04T10:00:00+08:00", updated_at: "2026-08-04T10:00:00+08:00"
  };
}

function makeConfirmation(proposalId: string): ConfirmationRecord {
  return {
    confirmation_id: "confirm-eval", confirmation_type: "CONTEXT_UPDATE", task_id: "eval-task",
    current_state: "WAITING_CONTEXT_CONFIRM", source_state: "CONTEXT_ANALYZING", return_state: "CONTEXT_TASK_COMPLETED",
    title: "确认稳定 Context 更新", items: [{ proposal_id: proposalId, approval_status: "APPROVED" }],
    allowed_actions: ["APPROVE_SELECTED"], status: "APPROVED", resolved_by: "USER",
    resolved_at: "2026-08-04T10:30:00+08:00", resolution: "APPROVE_SELECTED"
  };
}
