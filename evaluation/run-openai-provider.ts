#!/usr/bin/env npx tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentOrchestrator } from "../scripts/agent/orchestrator.js";
import { OpenAIResponsesClient } from "../scripts/agent/openai-client.js";
import { OpenAICompatibleClient } from "../scripts/agent/openai-compatible-client.js";
import { AnthropicMessagesClient } from "../scripts/agent/anthropic-client.js";
import type { ModelJsonRequest, StructuredModelClient } from "../scripts/agent/model-client.js";
import { OpenAIProvider } from "../scripts/agent/openai-provider.js";
import { SKILL_NAMES, SkillRuntime } from "../scripts/agent/skill-runtime.js";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import { inspectModelProviderConfig } from "../scripts/lib/model-provider-config.js";
import type { PrdWriteOutput } from "../scripts/lib/prd-types.js";
import { agentRunsPath, readJson, repoRefToPath, writeJsonAtomic } from "../scripts/lib/repository.js";
import { isolateRuntime } from "./runtime-isolation.js";

isolateRuntime(PROJECT_ROOT);

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
  const skillRuntime = new SkillRuntime(PROJECT_ROOT);
  const loadedSkills = SKILL_NAMES.map((name) => skillRuntime.load(name));
  const compiledSkills = skillRuntime.buildInstructions(SKILL_NAMES.map((name) => ({ name })), "离线 Skill 加载校验");
  results.push(
    check("MODEL-13", loadedSkills.every((skill) => skill.promptVersion === "0.2.0" && skill.references.length > 0 && skill.examples.length > 0 && /^[a-f0-9]{64}$/.test(skill.sha256)), "六个 Skill 的 Prompt、规则、示例和内容哈希可被 Runtime 加载"),
    check("MODEL-14", loadedSkills.every((skill) => compiledSkills.includes(`## 激活 Skill: ${skill.name}`) && compiledSkills.includes(String(skill.schema.$id))), "指令编译结果包含六个 Skill 及其业务 Schema"),
  );

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
  const compatibleBody = compatibleRequests[0] as { model?: string; response_format?: { type?: string }; messages?: Array<{ role?: string; content?: string }> };
  results.push(
    check("MODEL-10", compatibleBody.model === "deepseek-chat" && compatibleBody.response_format?.type === "json_object", "OpenAI 兼容服务使用 Chat Completions JSON 模式"),
    check("MODEL-11", compatibleResult.ok === true, "OpenAI 兼容服务响应可统一解析"),
    check("MODEL-15", compatibleBody.messages?.[0]?.content?.includes("本轮阶段性响应 JSON Schema") === true, "DeepSeek、Kimi 等兼容模型会显式收到阶段性响应 Schema"),
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
  const runtimeRequests: Array<Record<string, unknown>> = [];
  const runtimeClient = new OpenAIResponsesClient({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_url, init) => {
      runtimeRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ output_text: JSON.stringify(runtimeOutput) }), { status: 200 });
    },
  });
  const response = await new AgentOrchestrator(new OpenAIProvider(runtimeClient, "test-model")).handleMessage(
    "整理并沉淀这份产品现状，不要写 PRD",
    { taskId, projectId, materialPath: sourceDir, debug: true },
  );
  const stableContext = path.join(PROJECT_ROOT, "context-workspace/context", projectId, "product");
  const runtimeRequest = runtimeRequests[0] as {
    instructions?: string;
    text?: { format?: { schema?: { properties?: { information_items?: { items?: { properties?: { information_type?: { enum?: string[] } } } } } } } };
  };
  results.push(
    check("MODEL-06", response.provider.id === "openai" && response.state.id === "WAITING_CONTEXT_CONFIRM", "模型 Provider 结果通过 Runtime 并停在 CP-C01"),
    check("MODEL-07", response.confirmation?.items.length === 1 && response.artifacts.some((item) => item.label === "结构化整理稿"), "Runtime 返回模型生成的候选和可阅读整理稿"),
    check("MODEL-08", !fs.existsSync(stableContext) || !fs.readdirSync(stableContext).some((name) => name.endsWith(".md")), "CP-C01 前模型不能写入稳定 Context"),
    check("MODEL-16", runtimeRequest.instructions?.includes("激活 Skill: material-ingest / ANALYZE") === true && runtimeRequest.instructions.includes("激活 Skill: context-maintain / ANALYZE") && runtimeRequest.instructions.includes("classification-rules.md"), "Runtime 的真实模型请求包含当前 Skill 和确定性规则"),
    check("MODEL-17", runtimeRequest.text?.format?.schema?.properties?.information_items?.items?.properties?.information_type?.enum?.includes("CONFIRMED_DECISION") === true, "Context 模型响应约束从 material-ingest Schema 派生"),
  );
  clearRuntime(taskId, projectId);

  const prdTaskId = "skill-driven-prd-eval";
  const prdProjectId = "skill-driven-prd";
  const prdRequests: ModelJsonRequest[] = [];
  const prdClient: StructuredModelClient = {
    providerId: "openai",
    async generateJson<T>(input: ModelJsonRequest): Promise<T> {
      prdRequests.push(input);
      const content = input.content as {
        sources?: Array<{ ref: string }>;
        core_markdown?: string;
        current_prd_markdown?: string;
        revision_decisions?: string;
      };
      const sourceRefs = content.sources?.map((item) => item.ref) ?? [];
      const outputs: Record<string, unknown> = {
        prd_thinking: {
          background_card: {
            materials_read: sourceRefs, source_refs: sourceRefs, current_state: "已读取项目 Context", problem: "待确认核心问题", target_users: ["待确认"], user_scenarios: ["待确认"],
            upstream_dependencies: [], downstream_impacts: [], confirmed_scope: [], confirmed_out_of_scope: [], conflicts: [], missing_information: ["目标与范围"],
          },
          decision_questions: [{ decision_id: "decision_scope", question: "请确认本期目标与范围", source_refs: sourceRefs }],
        },
        prd_core: { core_markdown: "# Skill Driven PRD\n\n## 1. 背景与问题\n待确认。\n\n## 2. 目标与非目标\n待确认。\n\n## 3. 目标用户\n待确认。\n\n## 4. 本期范围\n待确认。\n\n## 5. 核心流程\n待确认。\n\n## 6. 已确认决策\n以 CP-P01 为准。" },
        prd_details: { details_markdown: `${content.core_markdown ?? "# Skill Driven PRD"}\n\n## 功能规则\n待确认。\n\n## 角色与权限\n待确认。\n\n## 边界与异常\n待确认。\n\n## 验收标准\n待确认。` },
        prd_revision: { details_markdown: `${content.current_prd_markdown ?? "# Skill Driven PRD"}\n\n## 审核修订结果\n${content.revision_decisions ?? ""}` },
        prd_review: { review_id: "review-skill-driven", reviewed_prd_version: "0.2.0", issues: [], summary: { p0_count: 0, p1_count: 0, p2_count: 0, recommendation: "PASS" }, passed_dimensions: ["FACT_STATUS", "SCOPE", "COMPLETENESS", "ACCEPTANCE", "DEPENDENCY", "CONSISTENCY", "OVER_DESIGN"], unverifiable_items: [] },
        prd_review_revision: { review_id: "review-skill-driven-revision", reviewed_prd_version: "0.2.1", issues: [], summary: { p0_count: 0, p1_count: 0, p2_count: 0, recommendation: "PASS" }, passed_dimensions: ["FACT_STATUS", "SCOPE", "COMPLETENESS", "ACCEPTANCE", "DEPENDENCY", "CONSISTENCY", "OVER_DESIGN"], unverifiable_items: [] },
      };
      return outputs[input.name] as T;
    },
  };
  clearRuntime(prdTaskId, prdProjectId);
  const prdProvider = new OpenAIProvider(prdClient, "test-model");
  prdProvider.setProjectId(prdProjectId);
  await prdProvider.getPrdAssets(prdTaskId, "THINKING");
  await prdProvider.getPrdAssets(prdTaskId, "CORE", { userConfirmation: "确认目标与范围" });
  const prdAssets = await prdProvider.getPrdAssets(prdTaskId, "DETAILS", { userConfirmation: "确认核心流程" });
  const detailsOutput = readJson<PrdWriteOutput>(prdAssets.detailsPath);
  const currentPrdPath = repoRefToPath(prdAssets.prdRef, PROJECT_ROOT);
  fs.mkdirSync(path.dirname(currentPrdPath), { recursive: true });
  fs.copyFileSync(repoRefToPath(detailsOutput.prd_artifact.content_ref, PROJECT_ROOT), currentPrdPath);
  const currentReviewPath = repoRefToPath(prdProvider.getPrdReportRefs(prdTaskId).reviewRef, PROJECT_ROOT);
  const persistedThinkingPath = repoRefToPath(prdProvider.getPrdReportRefs(prdTaskId).thinkingRef, PROJECT_ROOT);
  fs.mkdirSync(path.dirname(persistedThinkingPath), { recursive: true });
  fs.copyFileSync(prdAssets.thinkingPath, persistedThinkingPath);
  writeJsonAtomic(currentReviewPath, {
    review_id: "review-skill-driven",
    reviewed_prd_version: "0.2.0",
    prd_sha256: "runtime-computed-in-production",
    issues: [{ issue_id: "CONSISTENCY-01", severity: "P1", dimension: "CONSISTENCY", location: "验收标准", description: "指标口径冲突", evidence: [], impact: "无法验收", recommended_fix: "确认强制标准", requires_replan: false }],
    summary: { p0_count: 0, p1_count: 1, p2_count: 0, recommendation: "FIX_BEFORE_DELIVERY" },
    passed_dimensions: [],
    unverifiable_items: [],
  });
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output", prdTaskId), { recursive: true, force: true });
  const revisionMessage = "补充具体修订决定。CONSISTENCY-01：P95<2 秒作为强制验收标准，不达标即阻塞交付；SCOPE-01：双向修复季节错配；拼音置信度阈值暂定 0.8。请按此修订并重新审核。";
  const revisionAssets = await prdProvider.getPrdAssets(prdTaskId, "REVISION", { revisionDecisions: revisionMessage });
  const prdRequestNames = prdRequests.map((item) => item.name);
  const detailsRequest = prdRequests.find((item) => item.name === "prd_details");
  const reviewRequest = prdRequests.find((item) => item.name === "prd_review");
  const revisionRequest = prdRequests.find((item) => item.name === "prd_revision");
  const revisionReviewRequest = prdRequests.find((item) => item.name === "prd_review_revision");
  const reviewContent = reviewRequest?.content as { pre_confirmation_analysis?: { decision_ledger?: Array<{ status?: string }> }; confirmed_decision_ledger?: { decisions?: Array<{ status?: string }> } } | undefined;
  const revisionReviewContent = revisionReviewRequest?.content as { pre_confirmation_analysis?: { decision_ledger?: Array<{ status?: string }> }; confirmed_decision_ledger?: { decisions?: Array<{ status?: string }> } } | undefined;
  const revisionContent = revisionRequest?.content as { current_prd_markdown?: string; current_review?: { review_id?: string }; revision_decisions?: string } | undefined;
  const revisionOutput = readJson<PrdWriteOutput>(revisionAssets.detailsPath);
  const reviewTemplate = JSON.parse(fs.readFileSync(revisionAssets.reviewTemplatePath, "utf-8")) as { review_id?: string; reviewed_prd_version?: string };
  results.push(
    check("MODEL-18", prdRequestNames.join(",") === "prd_thinking,prd_core,prd_details,prd_review,prd_revision,prd_review_revision", "PRD 初稿与审核修订分别调用模型并重新审核"),
    check("MODEL-19", detailsRequest?.instructions.includes("激活 Skill: prd-write / DETAILS") === true && !detailsRequest.instructions.includes("激活 Skill: prd-review"), "DETAILS 调用只由 prd-write Skill 驱动"),
    check("MODEL-20", reviewRequest?.instructions.includes("激活 Skill: prd-review / REVIEW") === true && revisionReviewRequest?.instructions.includes("激活 Skill: prd-review / REVIEW") === true, "初次审核和修订后审核都只由 prd-review Skill 驱动"),
    check("MODEL-27", reviewContent?.pre_confirmation_analysis?.decision_ledger?.some((item) => item.status === "PENDING") === true && reviewContent?.confirmed_decision_ledger?.decisions?.every((item) => item.status === "CONFIRMED") === true, "初次审核同时携带写前分析与正式确认账本"),
    check("MODEL-28", revisionReviewContent?.pre_confirmation_analysis?.decision_ledger?.some((item) => item.status === "PENDING") === true && revisionReviewContent?.confirmed_decision_ledger?.decisions?.every((item) => item.status === "CONFIRMED") === true, "审核修订后的复审同样携带写前分析与正式确认账本"),
    check("MODEL-24", revisionRequest?.instructions.includes("激活 Skill: prd-write / REVISION") === true && revisionContent?.current_prd_markdown?.includes("验收标准") === true && revisionContent.current_review?.review_id === "review-skill-driven" && revisionContent.revision_decisions === revisionMessage, "REVISION 模型输入包含当前 PRD、当前审核报告和用户修订决定"),
    check("MODEL-25", revisionOutput.prd_artifact.version === "0.2.1" && revisionOutput.prd_artifact.previous_version === "0.2.0" && reviewTemplate.reviewed_prd_version === "0.2.1", "审核修订递增到 0.2.1 且重新审核同一版本"),
    check("MODEL-26", fs.existsSync(revisionAssets.detailsPath) && revisionRequest !== undefined, "Provider 中间缓存清理后仍可依据已发布 PRD 和报告恢复 REVISION"),
  );
  clearRuntime(prdTaskId, prdProjectId);

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

  const secret = "sk-eval-secret-value";
  const configuredStatus = inspectModelProviderConfig({
    MODEL_PROVIDER: "openai",
    OPENAI_API_KEY: secret,
    OPENAI_MODEL: "test-model",
  });
  const incompleteStatus = inspectModelProviderConfig({ MODEL_PROVIDER: "deepseek" });
  results.push(
    check("MODEL-21", configuredStatus.ready && configuredStatus.provider === "openai" && configuredStatus.model === "test-model", "模型配置检查识别已完整配置的真实 Provider"),
    check("MODEL-22", !JSON.stringify(configuredStatus).includes(secret) && configuredStatus.api_key_configured, "模型配置检查只报告密钥是否存在，不泄露密钥内容"),
    check("MODEL-23", !incompleteStatus.ready && incompleteStatus.issues.includes("缺少 DEEPSEEK_API_KEY") && incompleteStatus.issues.includes("缺少 DEEPSEEK_MODEL"), "模型配置检查准确列出缺失项"),
  );

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
    path.join(PROJECT_ROOT, "context-workspace/context", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId),
    agentRunsPath(taskId),
    path.join(PROJECT_ROOT, ".cache/manifests", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/prd", `${projectId}-${taskId}.md`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/prd-recovery", `prd-${projectId}`),
  ]) fs.rmSync(target, { recursive: true, force: true });
  const prdRecovery = path.join(PROJECT_ROOT, "context-workspace/workspace/prd-recovery");
  if (fs.existsSync(prdRecovery) && fs.readdirSync(prdRecovery).length === 0) fs.rmdirSync(prdRecovery);
}

function check(caseId: string, passed: boolean, detail: string): Result {
  return { case_id: caseId, passed, detail };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
