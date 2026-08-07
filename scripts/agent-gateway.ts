#!/usr/bin/env npx tsx
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { readTaskState } from "./lib/config.js";
import type {
  ExternalAgentRequest,
  ExternalAgentResponse,
} from "./gateway/types.js";
import type { TaskState } from "./lib/types.js";
import { runtimeSummary } from "./gateway/types.js";
import { InlineMaterialError, writeInlineMaterials } from "./gateway/inline-materials.js";

const agent = new AgentOrchestrator();

async function main() {
  const terminal = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of terminal) {
    if (!line.trim()) continue;
    const response = await handleLine(line);
    output.write(`${JSON.stringify(response)}\n`);
  }
  terminal.close();
}

async function handleLine(line: string): Promise<ExternalAgentResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return errorResponse("unknown", "INVALID_JSON", "输入不是合法 JSON");
  }

  const current = readTaskState();
  const validation = validateRequest(raw, current);
  if (!validation.ok) {
    const requestId = isRecord(raw) && typeof raw.request_id === "string"
      ? raw.request_id
      : "unknown";
    return errorResponse(requestId, "INVALID_REQUEST", validation.error);
  }

  const request = validation.request;
  try {
    const current = readTaskState();
    const hasUnfinishedTask = current && !["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(current.current_state);
    if (hasUnfinishedTask && request.task_id && request.task_id !== current.task_id) {
      throw new Error(`当前运行任务是 ${current.task_id}，不是 ${request.task_id}`);
    }
    if (hasUnfinishedTask && request.project_id && request.project_id.toLowerCase() !== current.project_id) {
      throw new Error(`当前运行任务属于项目 ${current.project_id}，不能用项目 ${request.project_id} 继续执行`);
    }
    const taskId = request.task_id ?? (current && !["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(current.current_state) ? current.task_id : undefined) ?? `agent-${Date.now()}`;
    const projectId = request.project_id?.toLowerCase() ?? (current && !["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(current.current_state) ? current.project_id : undefined);
    const inlineMaterialPath = request.materials?.length
      ? writeInlineMaterials(request.materials, projectId ?? "default-project", taskId, request.message)
      : undefined;
    const response = await agent.handleMessage(request.message, {
      taskId,
      sessionId: request.session_id,
      projectId,
      materialPath: inlineMaterialPath ?? request.material_path,
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
    if (error instanceof InlineMaterialError) {
      return {
        protocol_version: "0.1",
        request_id: request.request_id,
        status: "INVALID_REQUEST",
        runtime: runtimeSummary(readTaskState()),
        error: { code: error.code, message: error.message },
      };
    }
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

function validateRequest(raw: unknown, current: TaskState | null):
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
  if (raw.project_id !== undefined && (typeof raw.project_id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw.project_id))) {
    return { ok: false, error: "project_id 只能包含字母、数字、下划线或连字符，长度不超过 64" };
  }
  for (const [field, value] of [
    ["task_id", raw.task_id],
    ["session_id", raw.session_id],
    ["project_id", raw.project_id],
    ["material_path", raw.material_path],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, error: `${field} 必须是字符串` };
    }
  }
  if (raw.materials !== undefined) {
    if (!Array.isArray(raw.materials) || raw.materials.length === 0) {
      return { ok: false, error: "materials 必须是非空数组" };
    }
    for (const [index, material] of raw.materials.entries()) {
      if (!isRecord(material) || typeof material.name !== "string" || !material.name.trim()) {
        return { ok: false, error: `materials[${index}].name 必须是非空字符串` };
      }
      if (typeof material.content !== "string" || !material.content.trim()) {
        return { ok: false, error: `materials[${index}].content 必须是非空字符串` };
      }
      for (const field of ["source_type", "source_owner", "source_time"] as const) {
        if (material[field] !== undefined && typeof material[field] !== "string") {
          return { ok: false, error: `materials[${index}].${field} 必须是字符串` };
        }
      }
      if (material.is_complete !== undefined && typeof material.is_complete !== "boolean") {
        return { ok: false, error: `materials[${index}].is_complete 必须是布尔值` };
      }
    }
  }
  if (raw.debug !== undefined && typeof raw.debug !== "boolean") {
    return { ok: false, error: "debug 必须是布尔值" };
  }
  if (raw.task_id === undefined && raw.material_path === undefined && raw.materials === undefined && !current) {
    return { ok: false, error: "新任务必须提供 material_path 或 materials" };
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
