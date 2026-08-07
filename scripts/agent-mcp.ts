#!/usr/bin/env npx tsx
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { readTaskState } from "./lib/config.js";
import type { TaskState } from "./lib/types.js";
import { InlineMaterialError, writeInlineMaterials } from "./gateway/inline-materials.js";
import type { ExternalAgentMaterial } from "./gateway/types.js";

const agent = new AgentOrchestrator();
const TOOL_NAME = "context_delivery";
const TOOL_DESCRIPTION = "将产品经理的自然语言任务和原始材料交给 Context 工程与需求交付 Runtime。Runtime 是唯一业务编排和文件执行中心；外部 Agent 只能展示工具返回的 artifacts。返回 WAITING_*、BLOCKED 或 ERROR 时必须停止，不得自行总结、写入 meeting-notes/ 等替代目录或宣称完成；只有 execution_status=COMPLETED 且 artifacts 非空时才可报告完成。";

async function main() {
  const terminal = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of terminal) {
    if (!line.trim()) continue;
    const response = await handleMessage(line);
    if (response === undefined) continue;
    output.write(`${JSON.stringify(response)}\n`);
  }
}

async function handleMessage(line: string): Promise<unknown> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "输入不是合法 JSON");
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(request.id ?? null, -32600, "MCP 请求必须包含 jsonrpc=2.0、id 和 method");
  }
  if (request.id === undefined) {
    if (request.method.startsWith("notifications/")) return undefined;
    return jsonRpcError(null, -32600, "MCP 请求必须包含 id");
  }
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "context-delivery-agent", version: "0.1.0" },
      });
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: [toolDefinition()] });
    }
    if (request.method === "ping") {
      return jsonRpcResult(request.id, {});
    }
    if (request.method === "tools/call") {
      return await callTool(request.id, request.params);
    }
    return jsonRpcError(request.id, -32601, `不支持的 MCP method: ${request.method}`);
  } catch (error) {
    if (error instanceof InlineMaterialError) return toolError(request.id, error.code, error.message);
    return jsonRpcResult(request.id, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "RUNTIME_EXECUTION_ERROR", message: errorMessage(error) }) }],
    });
  }
}

async function callTool(id: JsonRpcId, params: unknown): Promise<unknown> {
  if (!isRecord(params) || params.name !== TOOL_NAME || !isRecord(params.arguments)) {
    return toolError(id, "INVALID_TOOL_INPUT", "tools/call 必须调用 context_delivery，并提供 arguments 对象");
  }
  const args = params.arguments;
  const current = readTaskState();
  const validation = validateArguments(args, current);
  if (!validation.ok) return toolError(id, "INVALID_TOOL_INPUT", validation.error);

  const hasUnfinishedTask = current && !["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(current.current_state);
  if (hasUnfinishedTask && args.task_id && args.task_id !== current.task_id) {
    return toolError(id, "TASK_MISMATCH", `当前运行任务是 ${current.task_id}，不是 ${args.task_id}`);
  }
  if (hasUnfinishedTask && args.project_id && args.project_id.toLowerCase() !== current.project_id) {
    return toolError(id, "PROJECT_MISMATCH", `当前运行任务属于项目 ${current.project_id}，不能用项目 ${args.project_id} 继续执行`);
  }
  const taskId = args.task_id ?? (current && !["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(current.current_state) ? current.task_id : undefined) ?? `agent-${Date.now()}`;
  const projectId = args.project_id ?? current?.project_id ?? "default-project";
  const inlinePath = args.materials?.length
    ? writeInlineMaterials(args.materials, projectId, taskId, args.message)
    : undefined;
  const response = await agent.handleMessage(args.message, {
    taskId,
    sessionId: args.session_id,
    projectId,
    materialPath: inlinePath ?? args.material_path,
    debug: false,
  });
  const result = {
    ...response,
    task_id: readTaskState()?.task_id ?? taskId,
    session_id: readTaskState()?.session_id ?? args.session_id ?? null,
    runtime_version: "0.1.0",
  };
  return jsonRpcResult(id, {
    isError: response.execution_status === "BLOCKED" || response.execution_status === "ERROR",
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  });
}

function toolDefinition() {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目标识，用于隔离 Context、材料和产物" },
        task_id: { type: "string", description: "继续任务时复用 Runtime 返回的 task_id" },
        session_id: { type: "string", description: "外部 Agent 会话标识" },
        message: { type: "string", description: "产品经理的自然语言原文或确认回复" },
        material_path: { type: "string", description: "同一文件系统中的材料目录或文件路径" },
        materials: {
          type: "array",
          description: "直接粘贴的原始材料；必须保留原文，不要传外部 Agent 总结",
          items: {
            type: "object",
            required: ["name", "content"],
            properties: {
              name: { type: "string" },
              content: { type: "string" },
              source_type: { type: "string" },
              source_owner: { type: "string" },
              source_time: { type: "string" },
              is_complete: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

function validateArguments(value: Record<string, unknown>, current: TaskState | null): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof value.message !== "string" || !value.message.trim()) return { ok: false, error: "message 必须是非空字符串" };
  for (const field of ["project_id", "task_id", "session_id", "material_path"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return { ok: false, error: `${field} 必须是字符串` };
  }
  if (value.materials !== undefined) {
    if (!Array.isArray(value.materials) || value.materials.length === 0) return { ok: false, error: "materials 必须是非空数组" };
    for (const [index, item] of value.materials.entries()) {
      if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) return { ok: false, error: `materials[${index}].name 必须是非空字符串` };
      if (typeof item.content !== "string" || !item.content.trim()) return { ok: false, error: `materials[${index}].content 必须是非空字符串` };
      for (const field of ["source_type", "source_owner", "source_time"] as const) {
        if (item[field] !== undefined && typeof item[field] !== "string") return { ok: false, error: `materials[${index}].${field} 必须是字符串` };
      }
      if (item.is_complete !== undefined && typeof item.is_complete !== "boolean") return { ok: false, error: `materials[${index}].is_complete 必须是布尔值` };
    }
  }
  if (value.material_path === undefined && value.materials === undefined && !value.task_id && !current) {
    return { ok: false, error: "新任务必须提供 material_path 或 materials；继续已有任务请提供 task_id" };
  }
  return { ok: true, value };
}

function toolError(id: JsonRpcId, code: string, message: string) {
  return jsonRpcResult(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] });
}

function jsonRpcResult(id: JsonRpcId, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id: JsonRpcId, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown; }

main().catch((error) => {
  output.write(`${JSON.stringify(jsonRpcError(null, -32603, errorMessage(error)))}\n`);
  process.exitCode = 1;
});
