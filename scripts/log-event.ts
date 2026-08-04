#!/usr/bin/env npx tsx
// ============================================================
// log-event.ts — 追加结构化事件到 task-events.jsonl
// ============================================================

import {
  appendEvent,
  readTaskState,
  uid,
  idempotencyKey,
  nowISO,
} from "./lib/config.js";
import type { EventType, Operator } from "./lib/types.js";

function usage(): never {
  console.error(
    [
      "用法: npx tsx scripts/log-event.ts",
      "  --task-id <id>",
      "  --event-type <TYPE>",
      "  [--previous-state <STATE>]",
      "  [--skill-name <name>]",
      "  [--skill-version <ver>]",
      "  [--prompt-version <ver>]",
      "  [--artifact-ref <ref>]",
      "  [--details <json>]",
      "  [--reason <text>]",
      "  [--operator USER|AGENT|SYSTEM]",
      "",
      "事件类型: STATE_TRANSITION, SKILL_CALL, SKILL_RESULT, USER_CONFIRMATION,",
      "         ARTIFACT_CREATED, VERSION_CREATED, ERROR,",
      "         TASK_PAUSED, TASK_RESUMED, TASK_CANCELLED",
    ].join("\n")
  );
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);

  const taskId = argVal(args, "--task-id");
  const eventType = argVal(args, "--event-type") as EventType;
  const previousState = argVal(args, "--previous-state");
  const skillName = argVal(args, "--skill-name");
  const skillVersion = argVal(args, "--skill-version");
  const promptVersion = argVal(args, "--prompt-version");
  const artifactRef = argVal(args, "--artifact-ref");
  const reason = argVal(args, "--reason");
  const operator: Operator = (argVal(args, "--operator") as Operator) ?? "SYSTEM";

  let details: Record<string, unknown> = {};
  const detailsRaw = argVal(args, "--details");
  if (detailsRaw) {
    try {
      details = JSON.parse(detailsRaw);
    } catch {
      console.error("--details 必须是有效 JSON");
      process.exit(1);
    }
  }

  if (reason) {
    details.reason = reason;
  }

  if (!taskId || !eventType) {
    console.error("缺少必填参数: --task-id, --event-type");
    usage();
  }

  // 读取当前状态作为 current_state
  const state = readTaskState();
  const currentState = state?.current_state ?? "INITIALIZING";

  const event = {
    event_id: uid(),
    event_type: eventType,
    task_id: taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(taskId, `event_${eventType}`),
    timestamp: nowISO(),
    operator,
    current_state: currentState,
    previous_state: previousState ?? null,
    skill_name: skillName ?? null,
    skill_version: skillVersion ?? null,
    prompt_version: promptVersion ?? null,
    artifact_ref: artifactRef ?? null,
    details,
  };

  appendEvent(event);
  console.log(JSON.stringify({ status: "logged", event }, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main();
