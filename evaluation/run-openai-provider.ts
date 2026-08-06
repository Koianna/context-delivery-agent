#!/usr/bin/env npx tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { OpenAIResponsesClient } from "../scripts/agent/openai-client.js";
import { OpenAICompatibleClient } from "../scripts/agent/openai-compatible-client.js";
import { AnthropicMessagesClient } from "../scripts/agent/anthropic-client.js";
import { OpenAIProvider } from "../scripts/agent/openai-provider.js";
import { PROJECT_ROOT } from "../scripts/lib/config.js";

interface Result { case_id: string; passed: boolean; detail: string }

async function main() {
  const requests: Array<Record<string, unknown>> = [];
  const expected = {
    information_items: [{
      item_id: "item-product-state",
      content: "当前产品支持导入会议材料。",
      information_type: "FACT",
      maturity: "CONFIRMED",
      source_refs: ["src-demo"],
      evidence: [{ source_id: "src-demo", location: "第 1 行", quote: "当前产品支持导入会议材料。" }],
      target_layer: "CONTEXT",
      confidence: 0.92,
      requires_confirmation: true,
    }],
    conflicts: [],
    remaining_questions: [],
    structured_markdown: "# 结构化材料整理稿\n\n## 背景与事实\n\n- 当前产品支持导入会议材料。",
  };
  const client = new OpenAIResponsesClient({
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 2_000,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ output_text: JSON.stringify(expected) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const actual = await client.generateJson<typeof expected>({
    name: "context_analysis",
    schema: { type: "object", additionalProperties: true },
    instructions: "只返回结构化结果",
    content: { source_id: "src-demo", content: "当前产品支持导入会议材料。" },
  });
  const body = requests[0] as {
    model?: string;
    text?: { format?: { type?: string; strict?: boolean; name?: string } };
    input?: string;
  };
  const results: Result[] = [
    check("MODEL-01", body.model === "test-model", "请求使用配置的模型"),
    check("MODEL-02", body.text?.format?.type === "json_schema" && body.text.format.strict === true, "Responses API 使用严格 JSON Schema 输出"),
    check("MODEL-03", body.text?.format?.name === "context_analysis" && typeof body.input === "string", "请求包含结构化任务名和输入材料"),
    check("MODEL-04", actual.information_items[0]?.evidence[0]?.quote === "当前产品支持导入会议材料。", "客户端解析模型结构化输出并保留来源证据"),
  ];

  const failedClient = new OpenAIResponsesClient({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
  });
  let failure = "";
  try {
    await failedClient.generateJson({ name: "failure", schema: {}, instructions: "", content: {} });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  results.push(check("MODEL-05", failure.includes("401") && failure.includes("invalid key"), "API 错误会阻止执行并保留可读原因"));

  const compatibleRequests: Array<Record<string, unknown>> = [];
  const compatible = new OpenAICompatibleClient({
    apiKey: "test-key",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    providerId: "deepseek",
    apiKeyName: "DEEPSEEK_API_KEY",
    fetchImpl: async (_url, init) => {
      compatibleRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 });
    },
  });
  const compatibleResult = await compatible.generateJson<{ ok: boolean }>({ name: "demo", schema: { type: "object" }, instructions: "返回 JSON", content: { value: 1 } });
  const compatibleBody = compatibleRequests[0] as { model?: string; response_format?: { type?: string }; messages?: unknown[] };
  results.push(
    check("MODEL-10", compatibleBody.model === "deepseek-chat" && compatibleBody.response_format?.type === "json_object", "OpenAI 兼容服务使用 Chat Completions JSON 模式"),
    check("MODEL-11", compatibleResult.ok === true, "OpenAI 兼容服务响应可统一解析"),
  );

  const claude = new AnthropicMessagesClient({
    apiKey: "test-key",
    model: "claude-test",
    fetchImpl: async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }), {
        status: String(url).endsWith("/v1/messages") && headers["anthropic-version"] === "2023-06-01" ? 200 : 400,
      });
    },
  });
  const claudeResult = await claude.generateJson<{ ok: boolean }>({ name: "demo", schema: { type: "object" }, instructions: "返回 JSON", content: { value: 1 } });
  results.push(check("MODEL-12", claudeResult.ok === true, "Claude Messages API 响应可统一解析"));

  const taskId = "openai-provider-offline-eval";
  const projectId = "model-provider-eval";
  const sourceText = "当前产品支持导入会议材料。";
  const sourceId = `src-${crypto.createHash("sha256").update(sourceText).digest("hex").slice(0, 10)}`;
  const sourceDir = path.join(PROJECT_ROOT, "runtime/openai-provider-eval-materials");
  clearRuntime(taskId, projectId);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "产品现状.md"), sourceText, "utf-8");
  const runtimeOutput = { ...expected, information_items: [{ ...expected.information_items[0], source_refs: [sourceId], evidence: [{ source_id: sourceId, location: "第 1 行", quote: sourceText }] }] };
  const runtimeClient = new OpenAIResponsesClient({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async () => new Response(JSON.stringify({ output_text: JSON.stringify(runtimeOutput) }), { status: 200 }),
  });
  const response = await new AgentOrchestrator(new OpenAIProvider(runtimeClient, "test-model")).handleMessage(
    "整理并沉淀这份产品现状，不要写 PRD",
    { taskId, projectId, materialPath: sourceDir, debug: true },
  );
  const stableContext = path.join(PROJECT_ROOT, "context-workspace/projects", projectId, "context/product");
  results.push(
    check("MODEL-06", response.provider.id === "openai" && response.state.id === "WAITING_CONTEXT_CONFIRM", "模型 Provider 结果通过 Runtime 并停在 CP-C01"),
    check("MODEL-07", response.confirmation?.items.length === 1 && response.artifacts.some((item) => item.label === "结构化整理稿"), "Runtime 返回模型生成的候选和可阅读整理稿"),
    check("MODEL-08", !fs.existsSync(stableContext) || !fs.readdirSync(stableContext).some((name) => name.endsWith(".md")), "CP-C01 前模型不能写入稳定 Context"),
  );
  clearRuntime(taskId, projectId);

  const blockedTaskId = "openai-provider-missing-key-eval";
  const blockedProjectId = "model-provider-blocked-eval";
  const blockedSourceDir = path.join(PROJECT_ROOT, "runtime/openai-provider-eval-materials");
  fs.mkdirSync(blockedSourceDir, { recursive: true });
  fs.writeFileSync(path.join(blockedSourceDir, "材料.md"), sourceText, "utf-8");
  const missingKeyClient = new OpenAIResponsesClient({ apiKey: "", model: "test-model" });
  const blocked = await new AgentOrchestrator(new OpenAIProvider(missingKeyClient, "test-model")).handleMessage(
    "整理这份产品现状，不要写 PRD",
    { taskId: blockedTaskId, projectId: blockedProjectId, materialPath: blockedSourceDir, debug: true },
  );
  results.push(check("MODEL-09", blocked.state.id === "EXECUTION_BLOCKED" && blocked.execution_status === "BLOCKED" && blocked.message.includes("OPENAI_API_KEY"), "缺少密钥时 Runtime 进入可恢复阻塞状态"));
  clearRuntime(blockedTaskId, blockedProjectId);

  const passed = results.filter((item) => item.passed).length;
  console.log(JSON.stringify({ evaluation_id: "openai-provider-offline", summary: { total: results.length, passed, failed: results.length - passed }, results }, null, 2));
  if (passed !== results.length) process.exit(1);
}

function clearRuntime(taskId: string, projectId: string): void {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  for (const target of [
    path.join(PROJECT_ROOT, "runtime/provider-output"),
    path.join(PROJECT_ROOT, "runtime/openai-provider-eval-materials"),
    path.join(PROJECT_ROOT, "context-workspace/drafts", projectId),
    path.join(PROJECT_ROOT, "context-workspace/projects", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskId),
  ]) fs.rmSync(target, { recursive: true, force: true });
}

function check(caseId: string, passed: boolean, detail: string): Result {
  return { case_id: caseId, passed, detail };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
