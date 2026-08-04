import * as fs from "node:fs";
import type { ChangeAnalysisOutput, ChangeSnapshotManifest, ReplanOutput, ReplanReturnState } from "./change-types.js";
import { currentArtifactsMatchSnapshot, sha256Buffer, validateSnapshotIntegrity } from "./change-snapshot.js";
import type { ConfirmationRecord, StateId, TaskState } from "./types.js";
import { readJson, repoRefToPath } from "./repository.js";

export const REPLAN_RETURN_STATES: ReplanReturnState[] = [
  "CONTEXT_ANALYZING",
  "PRD_THINKING",
  "PRD_DRAFTING_CORE",
  "PRD_DRAFTING_DETAILS",
];

export function validateReplanApproval(
  confirmation: ConfirmationRecord | undefined,
  taskId: string,
  targetState?: StateId,
  root?: string
): string[] {
  const errors: string[] = [];
  const payload = confirmation?.items[0];
  if (!confirmation || confirmation.confirmation_type !== "REPLAN_APPROVAL") {
    return ["缺少 CP-R01 记录"];
  }
  if (confirmation.task_id !== taskId) errors.push("CP-R01 task_id 不匹配");
  if (confirmation.status !== "APPROVED" || confirmation.resolution !== "APPROVE_REPLAN") {
    errors.push("CP-R01 尚未批准新计划");
  }
  const approvedReturn = payload?.approved_return_state;
  if (typeof approvedReturn !== "string" || !REPLAN_RETURN_STATES.includes(approvedReturn as ReplanReturnState)) {
    errors.push("CP-R01 返回节点不在白名单");
  }
  if (targetState && approvedReturn !== targetState) errors.push("状态转移目标与 CP-R01 批准的返回节点不一致");
  for (const field of ["change_id", "approved_plan_version", "snapshot_ref", "analysis_ref", "plan_ref"] as const) {
    if (typeof payload?.[field] !== "string") errors.push(`CP-R01 缺少 ${field}`);
  }
  if (typeof payload?.approved_plan_sha256 !== "string") errors.push("CP-R01 缺少批准计划 hash");
  if (!Array.isArray(payload?.preserved_artifact_refs)) errors.push("CP-R01 缺少保留产物清单");
  if (!Array.isArray(payload?.deprecated_artifact_refs)) errors.push("CP-R01 缺少待替代产物清单");
  if (["PRD_DRAFTING_CORE", "PRD_DRAFTING_DETAILS"].includes(String(approvedReturn))
    && typeof payload?.approved_prd_base_version !== "string") {
    errors.push("CP-R01 缺少 PRD 修订基线版本");
  }

  if (root && typeof payload?.plan_ref === "string") {
    try {
      const plan = readJson<ReplanOutput>(repoRefToPath(payload.plan_ref, root));
      if (plan.change_id !== payload.change_id) errors.push("CP-R01 change_id 与计划不一致");
      if (plan.plan.version !== payload.approved_plan_version) errors.push("CP-R01 批准版本与计划不一致");
      if (hashReplanForApproval(plan) !== payload.approved_plan_sha256) errors.push("CP-R01 批准的计划 hash 与当前计划不一致");
      if (plan.plan.recommended_return_state !== approvedReturn) errors.push("CP-R01 返回节点与计划不一致");
      if (plan.snapshot_ref !== payload.snapshot_ref || plan.analysis_ref !== payload.analysis_ref) {
        errors.push("CP-R01 的快照或分析引用与计划不一致");
      }
      const analysisPath = repoRefToPath(plan.analysis_ref, root);
      if (sha256Buffer(fs.readFileSync(analysisPath)) !== plan.analysis_sha256) {
        errors.push("计划引用的影响报告 hash 与当前报告不一致");
      }
      if (typeof payload.approved_prd_base_version === "string") {
        const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(plan.snapshot_ref, root));
        if (manifest.baseline_versions.prd_version !== payload.approved_prd_base_version) {
          errors.push("CP-R01 的 PRD 修订基线与快照不一致");
        }
      }
      const preserved = new Set(payload.preserved_artifact_refs as string[]);
      if (plan.plan.preserved_artifacts.some((ref) => !preserved.has(ref))) errors.push("CP-R01 未确认全部保留产物");
      const deprecated = new Set(payload.deprecated_artifact_refs as string[]);
      if (plan.plan.deprecated_artifacts.some((ref) => !deprecated.has(ref))) errors.push("CP-R01 未确认全部待替代产物");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

export function hashReplanForApproval(plan: ReplanOutput): string {
  const normalized: ReplanOutput = { ...plan, plan: { ...plan.plan, status: "DRAFT" } };
  return sha256Buffer(JSON.stringify(normalized, null, 2) + "\n");
}

export function validatePrdRevisionScope(
  confirmation: ConfirmationRecord | undefined,
  targetRef: string,
  currentBody: string,
  candidateBody: string,
  root: string
): string[] {
  const errors: string[] = [];
  const analysisRef = confirmation?.items[0]?.analysis_ref;
  if (typeof analysisRef !== "string") return ["CP-R01 缺少影响报告引用"];
  try {
    const analysis = readJson<ChangeAnalysisOutput>(repoRefToPath(analysisRef, root));
    const preservedLocations = analysis.unaffected_items
      .filter((item) => item.artifact_ref === targetRef)
      .flatMap((item) => item.locations);
    if (!preservedLocations.length) return ["影响报告没有声明 PRD 保留章节"];
    const currentSections = markdownSections(currentBody);
    const candidateSections = markdownSections(candidateBody);
    for (const location of preservedLocations) {
      if (location === "全部") {
        if (currentBody.trim() !== candidateBody.trim()) errors.push("PRD 被标记为全部保留但候选正文发生变化");
        continue;
      }
      const current = currentSections.get(location);
      const candidate = candidateSections.get(location);
      if (!current || !candidate) {
        errors.push(`无法定位保留章节: ${location}`);
      } else if (current !== candidate) {
        errors.push(`未受影响章节发生变化: ${location}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function markdownSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(/^## (.+)$/gm)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? body.length;
    sections.set(match[1].trim(), body.slice(start, end).trim());
  }
  return sections;
}

export function validateAppliedReplan(
  confirmation: ConfirmationRecord | undefined,
  state: TaskState,
  targetState: StateId,
  maxReplan: number,
  root: string
): string[] {
  const errors = validateReplanApproval(confirmation, state.task_id, targetState, root);
  const payload = confirmation?.items[0];
  if (state.return_state !== targetState) errors.push("Harness 尚未应用批准的返回节点");
  if (state.plan_version !== payload?.approved_plan_version) errors.push("Harness 尚未应用批准的计划版本");
  if (state.replan_count < 1) errors.push("replan_count 尚未递增");
  if (state.replan_count > maxReplan) errors.push("重规划次数超过上限");
  return errors;
}

export function validateReplanRevision(
  confirmation: ConfirmationRecord | undefined,
  taskId: string
): string[] {
  if (!confirmation || confirmation.confirmation_type !== "REPLAN_APPROVAL") return ["缺少 CP-R01 记录"];
  const errors: string[] = [];
  if (confirmation.task_id !== taskId) errors.push("CP-R01 task_id 不匹配");
  if (confirmation.status !== "APPROVED" || confirmation.resolution !== "REVISE_REPLAN") errors.push("用户未要求修改重规划方案");
  if (typeof confirmation.items[0]?.revision_request !== "string") errors.push("修改计划缺少 revision_request");
  return errors;
}

export function validateChangeCancellation(
  confirmation: ConfirmationRecord | undefined,
  taskId: string,
  targetState?: StateId,
  root?: string
): string[] {
  if (!confirmation || confirmation.confirmation_type !== "REPLAN_APPROVAL") return ["缺少 CP-R01 记录"];
  const errors: string[] = [];
  const payload = confirmation.items[0];
  if (confirmation.task_id !== taskId) errors.push("CP-R01 task_id 不匹配");
  if (confirmation.status !== "CANCELLED" || confirmation.resolution !== "CANCEL_CHANGE") errors.push("用户未取消本次变更");
  if (typeof payload?.snapshot_ref !== "string") errors.push("取消变更缺少 snapshot_ref");
  if (root && typeof payload?.snapshot_ref === "string") {
    errors.push(...validateSnapshotIntegrity(payload.snapshot_ref, root));
    try {
      const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(payload.snapshot_ref, root));
      if (targetState && manifest.source_state !== targetState) errors.push("恢复目标不是快照原状态");
      if (!currentArtifactsMatchSnapshot(payload.snapshot_ref, root)) errors.push("业务产物尚未恢复到快照版本");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
