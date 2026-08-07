import {
  appendEvent,
  getConfirmationTypeForState,
  idempotencyKey,
  nowISO,
  readPendingConfirmations,
  readTaskState,
  uid,
  writePendingConfirmations,
} from "./config.js";
import type {
  ConfirmationItem,
  ConfirmationRecord,
  ConfirmationStatus,
  ConfirmationType,
  Operator,
  StateId,
} from "./types.js";

export interface CreateConfirmationInput {
  taskId: string;
  type: ConfirmationType;
  state: StateId;
  title: string;
  actions: string[];
  items?: Array<Record<string, unknown>>;
  sourceState?: StateId;
  returnState?: StateId;
}

export interface ResolveConfirmationInput {
  taskId: string;
  confirmationId: string;
  resolution: string;
  selectedIds?: string[];
  rejectedIds?: string[];
  operator?: Operator;
}

export function createConfirmation(input: CreateConfirmationInput): ConfirmationRecord {
  const taskState = readTaskState();
  if (!taskState || taskState.task_id !== input.taskId) {
    throw new Error(`任务 ${input.taskId} 不存在`);
  }
  const expectedType = getConfirmationTypeForState(input.state);
  if (!expectedType || expectedType !== input.type) {
    throw new Error(
      `状态 ${input.state} 要求的确认类型是 ${expectedType ?? "NONE"}，不能创建 ${input.type}`
    );
  }

  const rawItems = input.items ?? [];
  const items = input.type === "CONTEXT_UPDATE"
    ? rawItems.filter((item) => item.requires_confirmation === true)
    : rawItems;
  if (input.type === "CONTEXT_UPDATE" && items.length === 0) {
    throw new Error("CONTEXT_UPDATE 确认至少需要一个 requires_confirmation=true 的 proposal");
  }

  let pending = readPendingConfirmations();
  if (!pending || pending.task_id !== input.taskId) {
    pending = { task_id: input.taskId, records: [] };
  }
  const existing = pending.records.find(
    (record) => record.current_state === input.state && record.status === "PENDING"
  );
  if (existing) {
    throw new Error(`状态 ${input.state} 已有 PENDING 确认: ${existing.confirmation_id}`);
  }

  const record: ConfirmationRecord = {
    confirmation_id: `confirm_${uid()}`,
    confirmation_type: input.type,
    task_id: input.taskId,
    current_state: input.state,
    source_state: input.sourceState ?? null,
    return_state: input.returnState ?? null,
    title: input.title,
    items: items.map((item) => ({ ...item, approval_status: "PENDING" })),
    allowed_actions: input.actions,
    status: "PENDING",
    resolved_by: null,
    resolved_at: null,
    resolution: null,
  };
  pending.records.push(record);
  writePendingConfirmations(pending);
  return record;
}

export function resolveConfirmation(input: ResolveConfirmationInput): ConfirmationRecord {
  const pending = readPendingConfirmations();
  if (!pending || pending.task_id !== input.taskId) {
    throw new Error(`任务 ${input.taskId} 没有待确认记录`);
  }
  const index = pending.records.findIndex(
    (record) => record.confirmation_id === input.confirmationId
  );
  if (index === -1) throw new Error(`确认记录 ${input.confirmationId} 不存在`);

  const record = pending.records[index];
  if (record.status !== "PENDING") {
    throw new Error(`确认记录 ${input.confirmationId} 不是 PENDING 状态（当前: ${record.status}）`);
  }
  if (
    record.allowed_actions.length > 0 &&
    !record.allowed_actions.includes(input.resolution)
  ) {
    throw new Error(
      `动作 "${input.resolution}" 不在允许范围内: ${record.allowed_actions.join(", ")}`
    );
  }

  const selectedIds = input.selectedIds ?? [];
  const rejectedIds = input.rejectedIds ?? [];
  if (input.resolution === "APPROVE_SELECTED" && selectedIds.length === 0) {
    throw new Error("APPROVE_SELECTED 必须指定 proposal_id");
  }
  const knownIds = new Set(
    record.items
      .map((item) => item.proposal_id)
      .filter((id): id is string => typeof id === "string")
  );
  const unknownIds = selectedIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length) {
    throw new Error(`选中项包含确认记录中不存在的 proposal_id: ${unknownIds.join(", ")}`);
  }
  const unknownRejectedIds = rejectedIds.filter((id) => !knownIds.has(id));
  if (unknownRejectedIds.length) {
    throw new Error(`拒绝项包含确认记录中不存在的 proposal_id: ${unknownRejectedIds.join(", ")}`);
  }

  const status = resolutionStatus(input.resolution);
  const resolved: ConfirmationRecord = {
    ...record,
    items: record.items.map((item) => ({
      ...item,
      approval_status: itemDecision(input.resolution, item.proposal_id, selectedIds, rejectedIds),
    })),
    status,
    resolved_by: input.operator ?? "USER",
    resolved_at: nowISO(),
    resolution: input.resolution,
  };
  pending.records[index] = resolved;
  writePendingConfirmations(pending);

  appendEvent({
    event_id: uid(),
    event_type: "USER_CONFIRMATION",
    task_id: input.taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(input.taskId, `confirm_resolve_${input.confirmationId}`),
    timestamp: nowISO(),
    operator: input.operator ?? "USER",
    current_state: record.current_state,
    previous_state: null,
    skill_name: null,
    skill_version: null,
    prompt_version: null,
    artifact_ref: null,
    details: {
      confirmation_id: input.confirmationId,
      confirmation_type: record.confirmation_type,
      status,
      resolution: input.resolution,
      selected_proposal_ids: selectedIds,
      rejected_proposal_ids: rejectedIds,
    },
  });
  return resolved;
}

export function listConfirmations(taskId: string): ConfirmationRecord[] {
  const pending = readPendingConfirmations();
  return pending?.task_id === taskId ? pending.records : [];
}

function resolutionStatus(resolution: string): ConfirmationStatus {
  if ([
    "APPROVE_ALL", "APPROVE_SELECTED", "CONFIRM", "APPROVE",
    "CONFIRM_WRITABLE", "APPROVE_CORE", "ACCEPT_AND_DELIVER",
    "DELIVER_WITH_NOTES", "FIX_AND_REVIEW", "APPROVE_REPLAN",
    "REVISE_REPLAN", "APPROVE_REPROCESS",
  ].includes(resolution)) return "APPROVED";
  if (resolution === "KEEP_EXISTING") return "DEFERRED";
  if (["REJECT", "REJECT_ALL"].includes(resolution)) return "REJECTED";
  if (["DEFER", "DEFER_ALL"].includes(resolution)) return "DEFERRED";
  if (["CANCEL", "CANCEL_CHANGE"].includes(resolution)) return "CANCELLED";
  throw new Error(`不支持的确认动作: ${resolution}`);
}

function itemDecision(
  resolution: string,
  proposalId: string | undefined,
  selectedIds: string[],
  rejectedIds: string[]
): ConfirmationItem["approval_status"] {
  if ([
    "APPROVE_ALL", "APPROVE", "CONFIRM", "CONFIRM_WRITABLE", "APPROVE_CORE",
    "ACCEPT_AND_DELIVER", "DELIVER_WITH_NOTES", "FIX_AND_REVIEW", "APPROVE_REPLAN",
    "REVISE_REPLAN", "APPROVE_REPROCESS",
  ].includes(resolution)) return "APPROVED";
  if (resolution === "APPROVE_SELECTED") {
    if (proposalId && rejectedIds.includes(proposalId)) return "REJECTED";
    return proposalId && selectedIds.includes(proposalId) ? "APPROVED" : "DEFERRED";
  }
  if (["DEFER", "DEFER_ALL"].includes(resolution)) return "DEFERRED";
  if (["REJECT", "REJECT_ALL", "CANCEL", "CANCEL_CHANGE"].includes(resolution)) {
    return "REJECTED";
  }
  return "PENDING";
}
