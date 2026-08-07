import * as fs from "node:fs";
import type { ConfirmationRecord, TaskState } from "./types.js";
import type { PrdWriteOutput } from "./prd-types.js";
import {
  incrementPatch, parseFrontmatter, renderFrontmatter, repoRefToPath, writeTextAtomic,
} from "./repository.js";
import { validateCoreConfirmation, validatePrdEntryConfirmation } from "./prd-guards.js";
import { validatePrdRevisionScope, validateReplanApproval } from "./change-guards.js";

export function latestConfirmation(
  confirmations: ConfirmationRecord[],
  type: ConfirmationRecord["confirmation_type"]
): ConfirmationRecord | undefined {
  return [...confirmations].reverse().find((record) => record.confirmation_type === type);
}

export function authorizePrdWrite(
  state: TaskState,
  confirmations: ConfirmationRecord[],
  output: PrdWriteOutput,
  root: string
): string[] {
  const errors: string[] = [];
  const artifact = output.prd_artifact;
  const expectedState = artifact.phase === "CORE" ? "PRD_DRAFTING_CORE" : "PRD_DRAFTING_DETAILS";
  if (state.current_state !== expectedState) {
    errors.push(`${artifact.phase} 写入要求状态 ${expectedState}，当前为 ${state.current_state}`);
  }
  if (!artifact.markdown_ref.startsWith("repo://context-workspace/workspace/prd/")) {
    errors.push("PRD 目标必须位于 context-workspace/workspace/prd/");
  }
  if (!artifact.source_refs.length) errors.push("PRD 必须保留来源引用");
  if (!artifact.decision_refs.length) errors.push("PRD 必须引用已确认决策");

  if (artifact.phase === "CORE") {
    const confirmation = latestConfirmation(confirmations, "DECISION_AND_WRITABLE_STATUS");
    const replanConfirmation = latestConfirmation(confirmations, "REPLAN_APPROVAL");
    const payload = confirmation?.items[0];
    const confirmedIds = Array.isArray(payload?.confirmed_decision_ids)
      ? payload.confirmed_decision_ids as string[]
      : [];
    const entryErrors = validatePrdEntryConfirmation(confirmation, state.task_id);
    const replanErrors = validateReplanApproval(replanConfirmation, state.task_id, "PRD_DRAFTING_CORE", root);
    if (entryErrors.length === 0) {
      if (artifact.decision_refs.some((id) => !confirmedIds.includes(id))) errors.push("PRD 引用了 CP-P01 未确认的决策");
      if (artifact.previous_version !== null || artifact.version !== "0.1.0") errors.push("CORE 首版必须是 0.1.0 且 previous_version 为 null");
    } else if (replanErrors.length === 0) {
      if (artifact.previous_version !== replanConfirmation?.items[0].approved_prd_base_version) errors.push("CORE 修订基线与 CP-R01 不一致");
    } else {
      errors.push(...entryErrors, ...replanErrors);
    }
  }

  if (artifact.phase === "DETAILS") {
    const confirmation = latestConfirmation(confirmations, "SCOPE_AND_CORE_FLOW");
    const replanConfirmation = latestConfirmation(confirmations, "REPLAN_APPROVAL");
    const payload = confirmation?.items[0];
    const coreErrors = validateCoreConfirmation(confirmation, state.task_id);
    const replanErrors = validateReplanApproval(replanConfirmation, state.task_id, "PRD_DRAFTING_DETAILS", root);
    if (coreErrors.length === 0) {
      if (payload?.approved_core_version !== artifact.previous_version) errors.push("DETAILS 的 previous_version 与 CP-P02 批准版本不一致");
      if (!Array.isArray(payload?.approved_scope) || !Array.isArray(payload?.approved_core_flow)) errors.push("CP-P02 缺少已确认范围或核心流程");
    } else if (replanErrors.length === 0) {
      if (artifact.previous_version !== replanConfirmation?.items[0].approved_prd_base_version) errors.push("DETAILS 修订基线与 CP-R01 不一致");
    } else {
      errors.push(...coreErrors, ...replanErrors);
    }
  }

  if (artifact.phase === "REVISION") {
    const reviewDisposition = latestConfirmation(confirmations, "REVIEW_DISPOSITION");
    if (reviewDisposition?.status !== "APPROVED" || reviewDisposition.resolution !== "FIX_AND_REVIEW") {
      errors.push("REVISION 写入要求 CP-P03 已选择 FIX_AND_REVIEW");
    }
    if (artifact.previous_version !== state.prd_version) {
      errors.push(`REVISION 基线版本与当前 PRD 不一致: 期望 ${state.prd_version}`);
    } else if (artifact.version !== incrementPatch(state.prd_version)) {
      errors.push(`REVISION 版本必须从 ${state.prd_version} 递增一个补丁版本`);
    }
  }

  try {
    const candidate = repoRefToPath(artifact.content_ref, root);
    if (!fs.existsSync(candidate)) errors.push(`PRD 候选内容不存在: ${artifact.content_ref}`);
    const target = repoRefToPath(artifact.markdown_ref, root);
    if (artifact.phase === "CORE" && fs.existsSync(target)) {
      const current = parseFrontmatter(fs.readFileSync(target, "utf-8"));
      const candidateBody = fs.existsSync(candidate)
        ? parseFrontmatter(fs.readFileSync(candidate, "utf-8")).body
        : "";
      const alreadyApplied = current.metadata.version === artifact.version && current.body.trim() === candidateBody.trim();
      const replanConfirmation = latestConfirmation(confirmations, "REPLAN_APPROVAL");
      const replanApproved = validateReplanApproval(replanConfirmation, state.task_id, "PRD_DRAFTING_CORE", root).length === 0;
      if (!alreadyApplied && !(replanApproved && current.metadata.version === artifact.previous_version)) {
        errors.push("CORE 目标已存在且不是同版本幂等内容");
      }
    }
    if (artifact.phase === "DETAILS" || artifact.phase === "REVISION") {
      if (!fs.existsSync(target)) {
        errors.push(`${artifact.phase} 写入前 PRD 文件不存在`);
      } else {
        const current = parseFrontmatter(fs.readFileSync(target, "utf-8"));
        const candidateBody = fs.existsSync(candidate)
          ? parseFrontmatter(fs.readFileSync(candidate, "utf-8")).body
          : "";
        const alreadyApplied = current.metadata.version === artifact.version && current.body.trim() === candidateBody.trim();
        if (current.metadata.version !== artifact.previous_version && !alreadyApplied) {
          errors.push(`PRD 基线版本冲突: 期望 ${artifact.previous_version}, 当前 ${current.metadata.version ?? "missing"}`);
        }
      }
    }
    const replanConfirmation = latestConfirmation(confirmations, "REPLAN_APPROVAL");
    const replanTarget = artifact.phase === "CORE" ? "PRD_DRAFTING_CORE" : "PRD_DRAFTING_DETAILS";
    if (fs.existsSync(target) && validateReplanApproval(replanConfirmation, state.task_id, replanTarget, root).length === 0) {
      const currentBody = parseFrontmatter(fs.readFileSync(target, "utf-8")).body;
      const candidateBody = fs.existsSync(candidate) ? parseFrontmatter(fs.readFileSync(candidate, "utf-8")).body : "";
      errors.push(...validatePrdRevisionScope(replanConfirmation, artifact.markdown_ref, currentBody, candidateBody, root));
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function writePrdArtifactFile(
  output: PrdWriteOutput,
  root: string,
  createdAt: string
): { status: "CREATED" | "UPDATED" | "UNCHANGED"; targetPath: string } {
  const artifact = output.prd_artifact;
  const targetPath = repoRefToPath(artifact.markdown_ref, root);
  const candidate = parseFrontmatter(fs.readFileSync(repoRefToPath(artifact.content_ref, root), "utf-8"));
  let status: "CREATED" | "UPDATED" | "UNCHANGED";
  if (fs.existsSync(targetPath)) {
    const current = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
    status = current.metadata.version === artifact.version && current.body.trim() === candidate.body.trim()
      ? "UNCHANGED"
      : "UPDATED";
  } else {
    status = "CREATED";
  }
  if (status !== "UNCHANGED") {
    const metadata: Record<string, string | string[] | null> = {
      id: artifact.artifact_id,
      version: artifact.version,
      previous_version: artifact.previous_version,
      phase: artifact.phase,
      status: artifact.phase === "CORE" ? "core-draft" : "review-ready",
      source_refs: artifact.source_refs,
      decision_refs: artifact.decision_refs,
      created_by: "prd-write",
      created_at: createdAt,
    };
    writeTextAtomic(targetPath, renderFrontmatter(metadata, candidate.body));
  }
  return { status, targetPath };
}
