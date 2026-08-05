#!/usr/bin/env npx tsx
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { readTaskState } from "./lib/config.js";
import type {
  ExternalAgentRequest,
  ExternalAgentResponse,
} from "./gateway/types.js";
import { runtimeSummary } from "./gateway/types.js";

const agent = new AgentOrchestrator();

async function main() {
  const terminal = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of terminal) {
    if (!line.trim()) continue;
    const response = handleLine(line);
    output.write(`${JSON.stringify(response)}\n`);
  }
  terminal.close();
}

function handleLine(line: string): ExternalAgentResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return errorResponse("unknown", "INVALID_JSON", "输入不是合法 JSON");
  }

  const validation = validateRequest(raw);
  if (!validation.ok) {
    const requestId = isRecord(raw) && typeof raw.request_id === "string"
      ? raw.request_id
      : "unknown";
    return errorResponse(requestId, "INVALID_REQUEST", validation.error);
  }

  const request = validation.request;
  try {
    const response = agent.handleMessage(request.message, {
      taskId: request.task_id,
      sessionId: request.session_id,
      materialPath: request.material_path,
      debug: request.debug,
    });
    return {
      protocol_version: "0.1",
      request_id: request.request_id,
      status: "SUCCESS",
      agent_response: response,
      runtime: runtimeSummary(readTaskState(), response),
      error: null,
    };
  } catch (error) {
    return {
      protocol_version: "0.1",
      request_id: request.request_id,
      status: "RUNTIME_ERROR",
      runtime: runtimeSummary(readTaskState()),
      error: {
        code: "RUNTIME_EXECUTION_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function validateRequest(raw: unknown):
  | { ok: true; request: ExternalAgentRequest }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "请求必须是 JSON 对象" };
  if (raw.protocol_version !== undefined && raw.protocol_version !== "0.1") {
    return { ok: false, error: "不支持的 protocol_version，仅支持 0.1" };
  }
  if (typeof raw.request_id !== "string" || !raw.request_id.trim()) {
    return { ok: false, error: "缺少非空 request_id" };
  }
  if (typeof raw.message !== "string" || !raw.message.trim()) {
    return { ok: false, error: "缺少非空 message" };
  }
  for (const [field, value] of [
    ["task_id", raw.task_id],
    ["session_id", raw.session_id],
    ["material_path", raw.material_path],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `${field} 必须是字符串` };
    }
  }
  if (raw.debug !== undefined && typeof raw.debug !== "boolean") {
    return { ok: false, error: "debug 必须是布尔值" };
  }
  if (raw.client !== undefined) {
    if (!isRecord(raw.client) || typeof raw.client.id !== "string" || !raw.client.id.trim()) {
      return { ok: false, error: "client.id 必须是非空字符串" };
    }
    if (raw.client.name !== undefined && typeof raw.client.name !== "string") {
      return { ok: false, error: "client.name 必须是字符串" };
    }
    if (raw.client.version !== undefined && typeof raw.client.version !== "string") {
      return { ok: false, error: "client.version 必须是字符串" };
    }
  }
  return { ok: true, request: raw as unknown as ExternalAgentRequest };
}

function errorResponse(
  requestId: string,
  code: string,
  message: string,
  status: ExternalAgentResponse["status"] = "INVALID_REQUEST"
): ExternalAgentResponse {
  return {
    protocol_version: "0.1",
    request_id: requestId,
    status,
    runtime: {
      task_id: null,
      session_id: null,
      current_state: null,
      provider: null,
      runtime_version: "0.1.0",
    },
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error) => {
  output.write(`${JSON.stringify(errorResponse("unknown", "GATEWAY_ERROR", error instanceof Error ? error.message : String(error), "RUNTIME_ERROR"))}\n`);
  process.exitCode = 1;
});
