#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createConfirmation,
  listConfirmations,
  resolveConfirmation,
} from "./lib/confirmation-runtime.js";
import { PROJECT_ROOT } from "./lib/config.js";
import type { ConfirmationType, Operator, StateId } from "./lib/types.js";

function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === "create") {
    const taskId = required(args, "--task-id");
    const actions = parseStringArray(required(args, "--actions"), "--actions");
    const confirmation = createConfirmation({
      taskId,
      type: required(args, "--type") as ConfirmationType,
      state: required(args, "--state") as StateId,
      title: required(args, "--title"),
      actions,
      items: readItems(args),
      sourceState: argVal(args, "--source") as StateId | undefined,
      returnState: argVal(args, "--return") as StateId | undefined,
    });
    console.log(JSON.stringify({ status: "created", confirmation }, null, 2));
    return;
  }
  if (command === "resolve") {
    const confirmation = resolveConfirmation({
      taskId: required(args, "--task-id"),
      confirmationId: required(args, "--confirmation-id"),
      resolution: required(args, "--resolution"),
      selectedIds: parseStringArray(argVal(args, "--selected") ?? "[]", "--selected"),
      operator: (argVal(args, "--operator") as Operator | undefined) ?? "USER",
    });
    console.log(JSON.stringify({ status: "resolved", confirmation }, null, 2));
    return;
  }
  if (command === "list") {
    const taskId = required(args, "--task-id");
    console.log(JSON.stringify({ task_id: taskId, records: listConfirmations(taskId) }, null, 2));
    return;
  }
  usage();
}

function readItems(args: string[]): Array<Record<string, unknown>> {
  const inline = argVal(args, "--items");
  const fileArg = argVal(args, "--items-file");
  if (inline && fileArg) throw new Error("--items 与 --items-file 只能使用一个");
  if (!inline && !fileArg) return [];
  if (inline) return parseItems(JSON.parse(inline) as unknown);
  const filePath = path.isAbsolute(fileArg!) ? fileArg! : path.join(PROJECT_ROOT, fileArg!);
  if (!fs.existsSync(filePath)) throw new Error(`确认项文件不存在: ${fileArg}`);
  return parseItems(JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown);
}

function parseItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === "object") {
    const proposals = (value as { update_proposals?: unknown }).update_proposals;
    if (Array.isArray(proposals)) return proposals as Array<Record<string, unknown>>;
    return [value as Record<string, unknown>];
  }
  throw new Error("确认项必须是 JSON 数组或对象");
}

function parseStringArray(raw: string, flag: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${flag} 必须是字符串 JSON 数组`);
  }
  return value;
}

function required(args: string[], flag: string): string {
  const value = argVal(args, flag);
  if (!value) throw new Error(`缺少 ${flag}`);
  return value;
}
function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
function usage(): never {
  console.error([
    "用法:",
    "  manage-confirmation.ts create --task-id <id> --type <TYPE> --state <STATE> --title <text> --actions <json> [--items <json>|--items-file <path>]",
    "  manage-confirmation.ts resolve --task-id <id> --confirmation-id <id> --resolution <RESOLUTION> [--selected <json-array>]",
    "  manage-confirmation.ts list --task-id <id>",
  ].join("\n"));
  process.exit(1);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
