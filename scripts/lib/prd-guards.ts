import type { ConfirmationRecord } from "./types.js";

export function validatePrdEntryConfirmation(
  confirmation: ConfirmationRecord | undefined,
  taskId?: string
): string[] {
  const errors: string[] = [];
  const payload = confirmation?.items[0];
  const decisions = Array.isArray(payload?.decisions)
    ? payload.decisions as Array<{ status?: string }>
    : [];
  const confirmedIds = Array.isArray(payload?.confirmed_decision_ids)
    ? payload.confirmed_decision_ids as string[]
    : [];
  if (!confirmation || confirmation.confirmation_type !== "DECISION_AND_WRITABLE_STATUS") {
    errors.push("缺少 CP-P01 记录");
    return errors;
  }
  if (taskId && confirmation.task_id !== taskId) errors.push("CP-P01 task_id 不匹配");
  if (confirmation.status !== "APPROVED" || confirmation.resolution !== "CONFIRM_WRITABLE") {
    errors.push("CP-P01 尚未确认可写");
  }
  if (payload?.writable_status !== true) errors.push("CP-P01 writable_status 不是 true");
  if (decisions.length === 0 || decisions.some((decision) => decision.status !== "CONFIRMED")) {
    errors.push("CP-P01 仍有未确认阻塞决策");
  }
  if (confirmedIds.length === 0) errors.push("CP-P01 未记录已确认决策清单");
  return errors;
}

export function validateCoreConfirmation(
  confirmation: ConfirmationRecord | undefined,
  taskId?: string
): string[] {
  const errors: string[] = [];
  const payload = confirmation?.items[0];
  if (!confirmation || confirmation.confirmation_type !== "SCOPE_AND_CORE_FLOW") {
    errors.push("缺少 CP-P02 记录");
    return errors;
  }
  if (taskId && confirmation.task_id !== taskId) errors.push("CP-P02 task_id 不匹配");
  if (confirmation.status !== "APPROVED" || confirmation.resolution !== "APPROVE_CORE") {
    errors.push("CP-P02 尚未批准 CORE");
  }
  if (typeof payload?.approved_core_version !== "string") errors.push("CP-P02 缺少 CORE 版本");
  if (!Array.isArray(payload?.approved_scope) || !payload.approved_scope.length) errors.push("CP-P02 缺少已确认范围");
  if (!Array.isArray(payload?.approved_core_flow) || !payload.approved_core_flow.length) errors.push("CP-P02 缺少已确认核心流程");
  return errors;
}

export function validateDeliveryConfirmation(
  confirmation: ConfirmationRecord | undefined,
  taskId?: string
): string[] {
  const errors: string[] = [];
  const payload = confirmation?.items[0];
  const summary = payload?.review_summary as Record<string, unknown> | undefined;
  if (!confirmation || confirmation.confirmation_type !== "REVIEW_DISPOSITION") {
    errors.push("缺少 CP-P03 记录");
    return errors;
  }
  if (taskId && confirmation.task_id !== taskId) errors.push("CP-P03 task_id 不匹配");
  if (confirmation.status !== "APPROVED" || confirmation.resolution !== "ACCEPT_AND_DELIVER") {
    errors.push("CP-P03 尚未选择接受并交付");
  }
  if (!summary) {
    errors.push("CP-P03 缺少审核摘要");
  } else if (summary.p0_count !== 0 || summary.p1_count !== 0) {
    errors.push("审核仍有 P0/P1 问题");
  }
  const acceptedP2Ids = Array.isArray(payload?.accepted_p2_issue_ids)
    ? payload.accepted_p2_issue_ids as string[]
    : [];
  if (summary && typeof summary.p2_count === "number" && acceptedP2Ids.length !== summary.p2_count) {
    errors.push("CP-P03 未逐项记录全部 P2 处理决定");
  }
  if (typeof payload?.accepted_review_id !== "string") errors.push("CP-P03 缺少接受的 review_id");
  return errors;
}
