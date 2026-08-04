#!/usr/bin/env npx tsx
// ============================================================
// manage-confirmation.ts — 创建、解析和关闭人工确认记录
// ============================================================

import {
  readPendingConfirmations,
  writePendingConfirmations,
  readTaskState,
  appendEvent,
  uid,
  idempotencyKey,
  nowISO,
  getConfirmationTypeForState,
  PROJECT_ROOT,
} from "./lib/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfirmationRecord,
  ConfirmationType,
  StateId,
  Operator,
  ConfirmationStatus,
} from "./lib/types.js";

function usage(): never {
  console.error(
    [
      "用法:",
      "  npx tsx scripts/manage-confirmation.ts create  --task-id <id> --type <TYPE> --state <STATE> --title <text> --actions <json> [--items <json>|--items-file <path>] [--source <state>] [--return <state>]",
      "  npx tsx scripts/manage-confirmation.ts resolve --task-id <id> --confirmation-id <id> --resolution <RESOLUTION> [--selected <json-array>] [--operator USER|AGENT|SYSTEM]",
      "  npx tsx scripts/manage-confirmation.ts list    --task-id <id>",
    ].join("\n")
  );
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || !["create", "resolve", "list"].includes(cmd)) usage();

  switch (cmd) {
    case "create":
      return cmdCreate(args.slice(1));
    case "resolve":
      return cmdResolve(args.slice(1));
    case "list":
      return cmdList(args.slice(1));
    default:
      usage();
  }
}

// ---- create ----
function cmdCreate(args: string[]) {
  const taskId = argVal(args, "--task-id");
  const type = argVal(args, "--type") as ConfirmationType;
  const state = argVal(args, "--state") as StateId;
  const title = argVal(args, "--title");
  const source = argVal(args, "--source") as StateId | undefined;
  const returnState = argVal(args, "--return") as StateId | undefined;

  const actionsRaw = argVal(args, "--actions");
  let actions: string[] = [];
  try {
    actions = actionsRaw ? JSON.parse(actionsRaw) : [];
  } catch {
    console.error("--actions 必须是有效 JSON 数组");
    process.exit(1);
  }

  const rawItems = readItems(args);

  if (!taskId || !type || !state || !title) {
    console.error("缺少必填参数: --task-id, --type, --state, --title");
    process.exit(1);
  }

  // 检查任务是否存在
  const taskState = readTaskState();
  if (!taskState || taskState.task_id !== taskId) {
    console.error(`任务 ${taskId} 不存在`);
    process.exit(1);
  }


  const expectedType = getConfirmationTypeForState(state);
  if (!expectedType || expectedType !== type) {
    console.error(
      `状态 ${state} 要求的确认类型是 ${expectedType ?? "NONE"}，不能创建 ${type}`
    );
    process.exit(1);
  }

  const items = type === "CONTEXT_UPDATE"
    ? rawItems.filter((item) => item.requires_confirmation === true)
    : rawItems;
  if (type === "CONTEXT_UPDATE" && items.length === 0) {
    console.error("CONTEXT_UPDATE 确认至少需要一个 requires_confirmation=true 的 proposal");
    process.exit(1);
  }

  // 读取或创建确认记录集
  let pc = readPendingConfirmations();
  if (!pc) {
    pc = { task_id: taskId, records: [] };
  }

  // 同一状态不能有多个 PENDING 确认
  const existing = pc.records.find(
    (r) => r.current_state === state && r.status === "PENDING"
  );
  if (existing) {
    console.error(
      `状态 ${state} 已有 PENDING 确认: ${existing.confirmation_id}`
    );
    process.exit(1);
  }

  const record: ConfirmationRecord = {
    confirmation_id: `confirm_${uid()}`,
    confirmation_type: type,
    task_id: taskId,
    current_state: state,
    source_state: source ?? null,
    return_state: returnState ?? null,
    title,
    items: items.map((item) => ({ ...item, approval_status: "PENDING" })),
    allowed_actions: actions,
    status: "PENDING",
    resolved_by: null,
    resolved_at: null,
    resolution: null,
  };

  pc.records.push(record);
  writePendingConfirmations(pc);

  console.log(JSON.stringify({ status: "created", confirmation: record }, null, 2));
}

// ---- resolve ----
function cmdResolve(args: string[]) {
  const taskId = argVal(args, "--task-id");
  const confirmationId = argVal(args, "--confirmation-id");
  const resolution = argVal(args, "--resolution");
  const operator: Operator = (argVal(args, "--operator") as Operator) ?? "USER";
  const selectedIds = parseStringArray(argVal(args, "--selected"), "--selected");

  if (!taskId || !confirmationId || !resolution) {
    console.error("缺少必填参数: --task-id, --confirmation-id, --resolution");
    process.exit(1);
  }

  const pc = readPendingConfirmations();
  if (!pc || pc.task_id !== taskId) {
    console.error(`任务 ${taskId} 没有待确认记录`);
    process.exit(1);
  }

  const idx = pc.records.findIndex((r) => r.confirmation_id === confirmationId);
  if (idx === -1) {
    console.error(`确认记录 ${confirmationId} 不存在`);
    process.exit(1);
  }

  const record = pc.records[idx];
  if (record.status !== "PENDING") {
    console.error(`确认记录 ${confirmationId} 不是 PENDING 状态（当前: ${record.status}）`);
    process.exit(1);
  }

  // 检查允许动作
  if (record.allowed_actions.length > 0 && !record.allowed_actions.includes(resolution)) {
    console.error(
      `动作 "${resolution}" 不在允许范围内: ${record.allowed_actions.join(", ")}`
    );
    process.exit(1);
  }


  if (resolution === "APPROVE_SELECTED" && selectedIds.length === 0) {
    console.error("APPROVE_SELECTED 必须通过 --selected 指定 proposal_id");
    process.exit(1);
  }

  const knownProposalIds = new Set(
    record.items
      .map((item) => item.proposal_id)
      .filter((id): id is string => typeof id === "string")
  );
  const unknownIds = selectedIds.filter((id) => !knownProposalIds.has(id));
  if (unknownIds.length > 0) {
    console.error(`--selected 包含确认记录中不存在的 proposal_id: ${unknownIds.join(", ")}`);
    process.exit(1);
  }

  // 映射 resolution 到状态
  let newStatus: ConfirmationStatus;
  switch (resolution) {
    case "APPROVE_ALL":
    case "APPROVE_SELECTED":
    case "CONFIRM":
    case "APPROVE":
      newStatus = "APPROVED";
      break;
    case "REJECT":
    case "REJECT_ALL":
      newStatus = "REJECTED";
      break;
    case "DEFER":
    case "DEFER_ALL":
      newStatus = "DEFERRED";
      break;
    case "CANCEL":
      newStatus = "CANCELLED";
      break;
    default:
      console.error(`不支持的确认动作: ${resolution}`);
      process.exit(1);
  }

  // 更新记录
  pc.records[idx] = {
    ...record,
    items: record.items.map((item) => ({
      ...item,
      approval_status: itemDecision(resolution, item.proposal_id, selectedIds),
    })),
    status: newStatus,
    resolved_by: operator,
    resolved_at: nowISO(),
    resolution,
  };

  writePendingConfirmations(pc);

  // 记录事件
  appendEvent({
    event_id: uid(),
    event_type: "USER_CONFIRMATION",
    task_id: taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(taskId, `confirm_resolve_${confirmationId}`),
    timestamp: nowISO(),
    operator,
    current_state: record.current_state,
    previous_state: null,
    skill_name: null,
    skill_version: null,
    prompt_version: null,
    artifact_ref: null,
    details: {
      confirmation_id: confirmationId,
      confirmation_type: record.confirmation_type,
      status: newStatus,
      resolution,
      selected_proposal_ids: selectedIds,
    },
  });

  console.log(
    JSON.stringify({ status: "resolved", confirmation: pc.records[idx] }, null, 2)
  );
}

function readItems(args: string[]): Array<Record<string, unknown>> {
  const inline = argVal(args, "--items");
  const fileArg = argVal(args, "--items-file");
  if (inline && fileArg) {
    console.error("--items 与 --items-file 只能使用一个");
    process.exit(1);
  }
  if (!inline && !fileArg) return [];

  let raw = inline;
  if (fileArg) {
    const filePath = path.isAbsolute(fileArg)
      ? fileArg
      : path.join(PROJECT_ROOT, fileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`确认项文件不存在: ${fileArg}`);
      process.exit(1);
    }
    raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { update_proposals?: unknown }).update_proposals)
    ) {
      return (parsed as { update_proposals: Array<Record<string, unknown>> }).update_proposals;
    }
    console.error("--items-file 必须是数组或包含 update_proposals 数组的 JSON");
    process.exit(1);
  }

  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as Array<Record<string, unknown>>;
  } catch {
    console.error("--items 必须是有效 JSON 数组");
    process.exit(1);
  }
}

function parseStringArray(raw: string | undefined, flag: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error();
    }
    return parsed;
  } catch {
    console.error(`${flag} 必须是字符串 JSON 数组`);
    process.exit(1);
  }
}

function itemDecision(
  resolution: string,
  proposalId: string | undefined,
  selectedIds: string[]
): "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED" {
  if (resolution === "APPROVE_ALL" || resolution === "APPROVE" || resolution === "CONFIRM") {
    return "APPROVED";
  }
  if (resolution === "APPROVE_SELECTED") {
    return proposalId && selectedIds.includes(proposalId) ? "APPROVED" : "DEFERRED";
  }
  if (resolution === "DEFER" || resolution === "DEFER_ALL") return "DEFERRED";
  if (resolution === "REJECT" || resolution === "REJECT_ALL" || resolution === "CANCEL") {
    return "REJECTED";
  }
  return "PENDING";
}

// ---- list ----
function cmdList(args: string[]) {
  const taskId = argVal(args, "--task-id");
  if (!taskId) {
    console.error("缺少 --task-id");
    process.exit(1);
  }

  const pc = readPendingConfirmations();
  if (!pc || pc.task_id !== taskId) {
    console.log(JSON.stringify({ task_id: taskId, records: [] }, null, 2));
    return;
  }

  console.log(JSON.stringify(pc, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main();
