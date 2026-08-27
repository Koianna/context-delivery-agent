import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeAnalysisOutput, ChangeType } from "../lib/change-types.js";
import { PROJECT_ROOT } from "../lib/config.js";
import { readMaterialContent } from "../lib/material-bundle.js";
import type { MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import { loadLocalEnv } from "../lib/env.js";
import type { ConfirmedDecisionLedger, PrdReviewTemplate, PrdThinkingOutput, PrdWriteOutput } from "../lib/prd-types.js";
import { parseFrontmatter, pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import type { TaskState } from "../lib/types.js";
import type { AgentProvider, ChangeAnalysisAssets, PrdProviderAssets, PrdProviderContext, PrdProviderPhase } from "./types.js";
import { OpenAIResponsesClient } from "./openai-client.js";
import type { StructuredModelClient } from "./model-client.js";
import { SkillRuntime } from "./skill-runtime.js";
import { renderSourceMaterialLines, renderUserFeedbackLines, writeStructuredMaterial } from "./structured-material.js";
import { WorkspaceProvider } from "./workspace-provider.js";
import { validatePrdReviewDecisionLedger } from "../validate-prd-output.js";

interface ContextModelOutput {
  information_items: MaterialIngestOutput["information_items"];
  conflicts: unknown[];
  remaining_questions: Array<{ question: string; source_refs: string[] }>;
  structured_markdown: string;
}

interface PrdThinkingModelOutput {
  background_card: PrdThinkingOutput["background_card"];
  decision_questions: Array<{ decision_id: string; question: string; source_refs: string[] }>;
}

interface PrdCoreModelOutput {
  core_markdown: string;
}

interface PrdDetailsModelOutput {
  details_markdown: string;
}

type PrdReviewModelOutput = PrdReviewTemplate;

interface ChangeModelOutput {
  change_type: ChangeType;
  is_material_change: boolean;
  confidence: number;
  old_value: string;
  new_value: string;
  affected_items: ChangeAnalysisOutput["affected_items"];
  unaffected_items: ChangeAnalysisOutput["unaffected_items"];
  risks: string[];
  open_questions: string[];
}

export class OpenAIProvider extends WorkspaceProvider implements AgentProvider {
  readonly id: string;
  readonly label: string;
  override readonly generationMode: AgentProvider["generationMode"] = "model";

  constructor(
    private readonly client: StructuredModelClient,
    private readonly model: string,
    providerId = client.providerId,
    label?: string,
    private readonly skills = new SkillRuntime(),
  ) {
    super();
    this.id = providerId;
    this.label = label ?? `${providerId} Provider (${model})`;
  }

  static fromEnv(): OpenAIProvider {
    loadLocalEnv();
    const model = process.env.OPENAI_MODEL ?? process.env.MODEL_ID ?? "";
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.API_KEY ?? "";
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? "120000");
    return new OpenAIProvider(new OpenAIResponsesClient({
      apiKey,
      model,
      baseUrl: process.env.OPENAI_BASE_URL,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 120_000,
    }), model);
  }

  async getContextAssets(materialPath?: string, taskId = "task", taskGoal = "整理项目材料") {
    const assets = await super.getContextAssets(materialPath, taskId, taskGoal);
    const input = readJson<MaterialIngestInput>(assets.inputPath);
    const sources = input.materials.map((material) => ({
      ...material,
      content: readMaterialContent(material, PROJECT_ROOT),
    }));
    const generated = await this.client.generateJson<ContextModelOutput>({
      name: "context_analysis",
      schema: contextResponseSchema(this.skills.load("material-ingest").schema),
      instructions: this.skills.buildInstructions(
        [{ name: "material-ingest", mode: "ANALYZE" }, { name: "context-maintain", mode: "ANALYZE" }],
        "从原始材料提取可追溯信息单元，识别冲突和待确认问题，并生成一份中文可阅读整理稿。用户反馈必须按完整记录表达，不能把用户 ID、时间和反馈正文拆成独立反馈。Runtime 会统计材料处理记录并根据信息单元构建 Context proposal。",
      ),
      content: { task_goal: taskGoal, project_id: this.projectId, sources },
    });
    const materialOutput = normalizeMaterialOutput(input, generated.information_items);
    const confirmedItems = materialOutput.information_items
      .filter((item) => item.requires_confirmation && item.target_layer === "CONTEXT");

    // 按材料来源分组：同一份材料的多条结论合并到一个文件
    const itemsBySource = new Map<string, typeof confirmedItems>();
    for (const item of confirmedItems) {
      const sourceKey = item.source_refs.join(",");
      if (!itemsBySource.has(sourceKey)) {
        itemsBySource.set(sourceKey, []);
      }
      itemsBySource.get(sourceKey)!.push(item);
    }

    // 为每组生成一个合并的 proposal
    const proposals = Array.from(itemsBySource.values()).map((items) => this.buildContextProposal(items));
    writeJsonAtomic(assets.materialOutputPath, materialOutput);
    writeJsonAtomic(assets.contextOutputPath, {
      action: "ANALYZE",
      update_proposals: proposals,
      conflicts: generated.conflicts,
      stale_items: [],
      index_issues: [],
      auto_actions: [],
      remaining_questions: generated.remaining_questions,
    });
    const artifactRef = pathToRepoRef(assets.structuredMaterialPath, PROJECT_ROOT);
    if (renderUserFeedbackLines(input, PROJECT_ROOT).length) {
      writeStructuredMaterial(input, materialOutput, assets.structuredMaterialPath, PROJECT_ROOT, artifactRef);
    } else {
      writeTextAtomic(assets.structuredMaterialPath, ensureStructuredMaterial(generated.structured_markdown, input, artifactRef));
    }
    return assets;
  }

  async getPrdAssets(taskId: string, phase: PrdProviderPhase = "REFERENCE", context: PrdProviderContext = {}): Promise<PrdProviderAssets> {
    const assets = await super.getPrdAssets(taskId, phase, context);
    const outputDir = this.outputDir(taskId);
    const thinkingPath = path.join(outputDir, "openai-prd-thinking.json");
    const corePath = path.join(outputDir, "openai-prd-core.json");
    const detailsPath = path.join(outputDir, "openai-prd-details.json");
    const reviewPath = path.join(outputDir, "openai-prd-review.json");
    const revisionVersion = phase === "REVISION"
      ? readJson<PrdWriteOutput>(assets.detailsPath).prd_artifact.version
      : null;
    const revisionPath = revisionVersion ? path.join(outputDir, `openai-prd-revision-${revisionVersion}.json`) : null;
    const revisionReviewPath = revisionVersion ? path.join(outputDir, `openai-prd-review-${revisionVersion}.json`) : null;

    if (phase === "THINKING" && !fs.existsSync(thinkingPath)) {
      writeJsonAtomic(thinkingPath, await this.generatePrdThinking(assets));
    }
    if (fs.existsSync(thinkingPath)) applyPrdThinking(readJson<PrdThinkingModelOutput>(thinkingPath), assets, this.projectId);

    if (phase === "CORE" && !fs.existsSync(corePath)) {
      if (!fs.existsSync(thinkingPath)) throw new Error("缺少已校验的 PRD 写前分析，不能生成 CORE");
      writeJsonAtomic(corePath, await this.generatePrdCore(assets, context.userConfirmation));
    }
    if (fs.existsSync(corePath)) applyPrdCore(readJson<PrdCoreModelOutput>(corePath), assets, this.projectId);

    if (phase === "DETAILS" && !fs.existsSync(detailsPath)) {
      if (!fs.existsSync(corePath)) throw new Error("缺少经 CP-P01 生成的 PRD CORE，不能生成 DETAILS");
      writeJsonAtomic(detailsPath, await this.generatePrdDetails(assets, context.userConfirmation));
    }
    if (phase !== "REVISION" && fs.existsSync(detailsPath)) {
      applyPrdDetails(readJson<PrdDetailsModelOutput>(detailsPath), assets, this.projectId);
    }
    if (phase === "DETAILS" && !fs.existsSync(reviewPath)) {
      writeJsonAtomic(reviewPath, await this.generatePrdReview(taskId, assets));
    }
    if (phase !== "REVISION" && fs.existsSync(reviewPath)) {
      applyPrdReview(readJson<PrdReviewModelOutput>(reviewPath), assets);
    }
    if (phase === "REVISION") {
      if (!revisionPath || !revisionReviewPath) throw new Error("无法确定 PRD 修订版本");
      const revisionDecisions = context.revisionDecisions ?? context.userConfirmation;
      if (!revisionDecisions?.trim()) throw new Error("缺少用户确认的 PRD 修订决定");
      if (!fs.existsSync(revisionPath)) {
        writeJsonAtomic(revisionPath, await this.generatePrdRevision(taskId, assets, revisionDecisions));
      }
      applyPrdDetails(readJson<PrdDetailsModelOutput>(revisionPath), assets, this.projectId);
      if (!fs.existsSync(revisionReviewPath)) {
        writeJsonAtomic(revisionReviewPath, await this.generatePrdReview(taskId, assets, "prd_review_revision"));
      }
      applyPrdReview(readJson<PrdReviewModelOutput>(revisionReviewPath), assets);
    }
    return assets;
  }

  async prepareChangeAnalysis(state: TaskState, message: string): Promise<ChangeAnalysisAssets> {
    const assets = await super.prepareChangeAnalysis(state, message);
    const input = readJson<Record<string, unknown>>(assets.inputPath);
    const artifactContents = readArtifactContents((input.artifact_refs as string[] | undefined) ?? []);
    const generated = await this.client.generateJson<ChangeModelOutput>({
      name: "change_analysis",
      schema: CHANGE_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "change-impact", mode: "ANALYZE" }],
        "对照用户变更请求、任务快照和当前业务产物，输出变更分类、受影响项、保留项、风险和待确认问题。返回节点由 Runtime 依据分类确定。",
      ),
      content: { change_request: message, task_state: state, artifacts: artifactContents },
    });
    const recommended = returnStateFor(generated.change_type);
    const analysis: ChangeAnalysisOutput = {
      mode: "ANALYZE",
      change_id: assets.changeId,
      snapshot_ref: `repo://context-workspace/workspace/snapshots/${assets.changeId}/manifest.json`,
      change_classification: {
        change_type: generated.change_type,
        is_material_change: generated.is_material_change,
        confidence: clamp(generated.confidence),
      },
      change_summary: {
        old_value: generated.old_value,
        new_value: generated.new_value,
        source_refs: ((input as { change_request?: { source_refs?: string[] } }).change_request?.source_refs ?? []),
      },
      affected_items: generated.affected_items,
      unaffected_items: generated.unaffected_items,
      recommended_return_state: recommended,
      risks: generated.risks,
      open_questions: generated.open_questions,
    };
    writeJsonAtomic(assets.analysisPath, analysis);
    return assets;
  }

  private async generatePrdThinking(assets: PrdProviderAssets): Promise<PrdThinkingModelOutput> {
    const sources = assets.thinkingSourceMeta.map((m) => ({
      ref: m.ref,
      category: m.category,
      maturity: m.maturity ?? null,
      content: readArtifactContentSafe(m.ref),
    }));
    return await this.client.generateJson<PrdThinkingModelOutput>({
      name: "prd_thinking",
      schema: PRD_THINKING_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "prd-thinking", mode: "ANALYZE" }],
        "生成 PRD 写作前的背景理解和 1 至 3 个必须由产品经理回答的阻塞决策问题，不生成 PRD 正文。",
      ),
      content: { project_id: this.projectId, sources },
    });
  }

  private async generatePrdCore(assets: PrdProviderAssets, userConfirmation?: string): Promise<PrdCoreModelOutput> {
    const thinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
    return await this.client.generateJson<PrdCoreModelOutput>({
      name: "prd_core",
      schema: PRD_CORE_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "prd-write", mode: "CORE" }],
        "依据经 CP-P01 确认的写前分析生成 PRD CORE Markdown，只包含主体结构，不提前展开 DETAILS。",
      ),
      content: { project_id: this.projectId, thinking, user_confirmation: userConfirmation ?? "" },
    });
  }

  private async generatePrdDetails(assets: PrdProviderAssets, userConfirmation?: string): Promise<PrdDetailsModelOutput> {
    const core = readJson<PrdWriteOutput>(assets.corePath);
    const coreMarkdown = fs.readFileSync(repoRefToPath(core.prd_artifact.content_ref, PROJECT_ROOT), "utf-8");
    return await this.client.generateJson<PrdDetailsModelOutput>({
      name: "prd_details",
      schema: PRD_DETAILS_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "prd-write", mode: "DETAILS" }],
        "保留已确认 CORE 的业务含义，补充功能规则、角色与权限、边界与异常、依赖和可验证验收标准，只返回完整 DETAILS Markdown。",
      ),
      content: { project_id: this.projectId, core_markdown: coreMarkdown, user_confirmation: userConfirmation ?? "" },
    });
  }

  private async generatePrdRevision(taskId: string, assets: PrdProviderAssets, revisionDecisions: string): Promise<PrdDetailsModelOutput> {
    const revision = readJson<PrdWriteOutput>(assets.detailsPath);
    const currentPrdPath = repoRefToPath(revision.prd_artifact.markdown_ref, PROJECT_ROOT);
    if (!fs.existsSync(currentPrdPath)) throw new Error("当前 PRD 不存在，不能执行审核修订");
    const currentPrd = fs.readFileSync(currentPrdPath, "utf-8");
    const reviewRef = this.getPrdReportRefs(taskId).reviewRef;
    const reviewPath = repoRefToPath(reviewRef, PROJECT_ROOT);
    if (!fs.existsSync(reviewPath)) throw new Error("当前 PRD 审核报告不存在，不能执行审核修订");
    const currentReview = readJson<PrdReviewTemplate & { prd_sha256?: string }>(reviewPath);
    return await this.client.generateJson<PrdDetailsModelOutput>({
      name: "prd_revision",
      schema: PRD_DETAILS_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "prd-write", mode: "REVISION" }],
        "严格依据用户对审核问题作出的修订决定，保留未受影响章节，返回一份完整 PRD 修订 Markdown。不得扩大用户未授权的范围。",
      ),
      content: {
        project_id: this.projectId,
        current_prd_markdown: currentPrd,
        current_review: currentReview,
        revision_decisions: revisionDecisions,
      },
    });
  }

  private async generatePrdReview(taskId: string, assets: PrdProviderAssets, requestName = "prd_review"): Promise<PrdReviewModelOutput> {
    const details = readJson<PrdWriteOutput>(assets.detailsPath);
    const prdMarkdown = fs.readFileSync(repoRefToPath(details.prd_artifact.content_ref, PROJECT_ROOT), "utf-8");
    const persistedThinkingPath = repoRefToPath(this.getPrdReportRefs(taskId).thinkingRef, PROJECT_ROOT);
    const reportRefs = this.getPrdReportRefs(taskId);
    const thinkingPath = fs.existsSync(assets.thinkingPath) ? assets.thinkingPath : persistedThinkingPath;
    if (!fs.existsSync(thinkingPath)) throw new Error("缺少已发布的 PRD 写前分析，不能执行独立审核");
    const thinking = readJson<PrdThinkingOutput>(thinkingPath);
    const ledgerPath = repoRefToPath(reportRefs.ledgerRef, PROJECT_ROOT);
    const ledgerErrors = validatePrdReviewDecisionLedger(details.prd_artifact.decision_refs, ledgerPath);
    if (ledgerErrors.length) throw new Error(`PRD 审核前决策账本校验失败:\n${ledgerErrors.join("\n")}`);
    const confirmedLedger = readJson<ConfirmedDecisionLedger>(ledgerPath);
    return await this.client.generateJson<PrdReviewModelOutput>({
      name: requestName,
      schema: PRD_REVIEW_SCHEMA,
      instructions: this.skills.buildInstructions(
        [{ name: "prd-review", mode: "REVIEW" }],
        "以独立审核者身份只读审查完整 PRD DETAILS，核对写前分析与决策，只返回审核模板；PRD 正文哈希由 Runtime 计算。",
      ),
      content: {
        project_id: this.projectId,
        prd_markdown: prdMarkdown,
        decision_ledger_ref: reportRefs.ledgerRef,
        pre_confirmation_analysis: thinking,
        confirmed_decision_ledger: confirmedLedger,
      },
    });
  }
}

function normalizeMaterialOutput(input: MaterialIngestInput, items: MaterialIngestOutput["information_items"]): MaterialIngestOutput {
  const allowedSources = new Set(input.materials.map((item) => item.source_id));
  const normalized = items.map((item, index) => ({
    ...item,
    item_id: safeId(item.item_id, `item-${index + 1}`),
    source_refs: item.source_refs.filter((ref) => allowedSources.has(ref)),
    evidence: item.evidence.filter((evidence) => allowedSources.has(evidence.source_id)),
    confidence: clamp(item.confidence),
    target_layer: item.target_layer === "CONTEXT" && item.maturity !== "CONFIRMED" ? "DRAFTS" as const : item.target_layer,
    requires_confirmation: item.target_layer === "CONTEXT" && item.maturity === "CONFIRMED",
  }));
  return {
    material_records: input.materials.map((material) => ({
      source_id: material.source_id,
      topic: input.analysis_scope.topic,
      processing_status: "PROCESSED" as const,
      missing_metadata: [!material.source_owner ? "source_owner" : null, !material.source_time ? "source_time" : null].filter((value): value is string => value !== null),
    })),
    information_items: normalized,
    processing_summary: {
      material_count: input.materials.length,
      processed_count: input.materials.length,
      failed_count: 0,
      information_item_count: normalized.length,
    },
    failed_materials: [],
  };
}

function applyPrdThinking(generated: PrdThinkingModelOutput, assets: PrdProviderAssets, projectId: string): void {
  const baselineThinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
  const sourceRefs = baselineThinking.background_card.source_refs;
  const decisions = generated.decision_questions.slice(0, 3).map((item, index) => ({
    decision_id: safeId(item.decision_id, `decision-${index + 1}`),
    question: item.question,
    status: "PENDING" as const,
    is_blocking: true,
    human_decision: null,
    source_refs: item.source_refs.filter((ref) => sourceRefs.includes(ref)),
  }));
  if (!decisions.length) throw new Error("模型没有生成 PRD 写前阻塞决策，Runtime 已停止");
  const decisionIds = decisions.map((item) => item.decision_id);
  const thinking: PrdThinkingOutput = {
    background_card: { ...generated.background_card, materials_read: sourceRefs, source_refs: sourceRefs },
    decision_ledger: decisions,
    writable_assessment: {
      status: "NEEDS_CONFIRMATION",
      checks: { background_aligned: true, goal_confirmed: false, scope_confirmed: false, critical_decisions_resolved: false, no_blockers: false },
      blockers: decisionIds,
      priority_questions: decisions.map((item) => ({ decision_id: item.decision_id, question: item.question })),
    },
  };
  writeJsonAtomic(assets.thinkingPath, thinking);
  writeJsonAtomic(assets.confirmedLedgerPath, {
    artifact_id: `decision-ledger-${safeId(projectId, "project")}`,
    version: "0.1.0",
    decisions: decisions.map((item) => ({ decision_id: item.decision_id, status: "CONFIRMED", decision: "按产品经理在 CP-P01 中确认的内容执行" })),
  });
  assets.p01 = {
    confirmation_type: "DECISION_AND_WRITABLE_STATUS",
    resolution: "CONFIRM_WRITABLE",
    writable_status: true,
    confirmed_decision_ids: decisionIds,
    decisions: decisions.map((item) => ({ decision_id: item.decision_id, status: "CONFIRMED", human_decision: "由产品经理确认" })),
    reason: "确认以上关键决策后生成 PRD 主体",
  };
}

function applyPrdCore(generated: PrdCoreModelOutput, assets: PrdProviderAssets, projectId: string): void {
  const thinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
  const decisionIds = thinking.decision_ledger.map((item) => item.decision_id);
  const core = readJson<PrdWriteOutput>(assets.corePath);
  writeTextAtomic(repoRefToPath(core.prd_artifact.content_ref, PROJECT_ROOT), withPrdFrontmatter(generated.core_markdown, projectId, "0.1.0"));
  core.prd_artifact.decision_refs = decisionIds;
  writeJsonAtomic(assets.corePath, core);
}

function applyPrdDetails(generated: PrdDetailsModelOutput, assets: PrdProviderAssets, projectId: string): void {
  const details = readJson<PrdWriteOutput>(assets.detailsPath);
  const decisionIds = details.prd_artifact.phase === "REVISION"
    ? details.prd_artifact.decision_refs
    : readJson<PrdThinkingOutput>(assets.thinkingPath).decision_ledger.map((item) => item.decision_id);
  writeTextAtomic(repoRefToPath(details.prd_artifact.content_ref, PROJECT_ROOT), withPrdFrontmatter(generated.details_markdown, projectId, details.prd_artifact.version));
  details.prd_artifact.decision_refs = decisionIds;
  writeJsonAtomic(assets.detailsPath, details);
}

function applyPrdReview(generated: PrdReviewModelOutput, assets: PrdProviderAssets): void {
  const reviewedVersion = readJson<PrdWriteOutput>(assets.detailsPath).prd_artifact.version;
  const review = { ...generated, reviewed_prd_version: reviewedVersion };
  writeJsonAtomic(assets.reviewTemplatePath, review);
  assets.p03 = {
    confirmation_type: "REVIEW_DISPOSITION",
    resolution: "ACCEPT_AND_DELIVER",
    disposition: review.summary.recommendation === "PASS" ? "ACCEPT" : "ACCEPT_WITH_NOTES",
    accepted_review_id: review.review_id,
    review_summary: review.summary,
    accepted_p2_issue_ids: review.issues.filter((item) => item.severity === "P2").map((item) => item.issue_id),
    reason: "请逐项处理审核结果后决定是否交付",
  };
}

function withPrdFrontmatter(markdown: string, projectId: string, version: string): string {
  const body = parseFrontmatter(markdown).body;
  return `---\nid: ${safeId(projectId, "project")}-prd\nversion: ${version}\n---\n\n${body}`;
}

function ensureStructuredMaterial(markdown: string, input: MaterialIngestInput, artifactRef: string): string {
  const body = markdown.trim();
  let normalized = body.startsWith("# ") ? body : `# 结构化材料整理稿\n\n${body}`;
  const feedbackLines = renderUserFeedbackLines(input, PROJECT_ROOT);
  if (feedbackLines.length) normalized = replaceMarkdownSection(normalized, "用户反馈", feedbackLines);
  normalized = replaceMarkdownSection(normalized, "来源材料", renderSourceMaterialLines(input, PROJECT_ROOT, artifactRef));
  return `${normalized}\n\n## 原文保留说明\n\n原始材料已由 Runtime 登记到 \`context-workspace/drafts/\`。本整理稿不替换原文，也不把未确认内容当作产品决策。\n\n- 任务目标：${input.task_goal}\n- 产物引用：${artifactRef}\n`;
}

function replaceMarkdownSection(markdown: string, heading: string, lines: string[]): string {
  const replacement = `## ${heading}\n\n${lines.map((line) => `- ${line}`).join("\n")}`;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n[\\s\\S]*?(?=\\n## |$)`);
  return pattern.test(markdown)
    ? markdown.replace(pattern, (match) => `${match.startsWith("\n") ? "\n" : ""}${replacement}`)
    : `${markdown}\n\n${replacement}`;
}

function readArtifactContents(refs: string[]): Array<{ ref: string; content: string }> {
  return refs.flatMap((ref) => {
    try {
      const file = repoRefToPath(ref, PROJECT_ROOT);
      return fs.existsSync(file) ? [{ ref, content: fs.readFileSync(file, "utf-8") }] : [];
    } catch {
      return [];
    }
  });
}

/** 读取单个资料文件（复用 repoRefToPath 解析，缺失返回 null） */
function readArtifactContentSafe(ref: string): string | null {
  try {
    const file = repoRefToPath(ref, PROJECT_ROOT);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  } catch {
    return null;
  }
}

function returnStateFor(type: ChangeType): ChangeAnalysisOutput["recommended_return_state"] {
  if (["SOURCE_CHANGE", "FACT_CHANGE"].includes(type)) return "CONTEXT_ANALYZING";
  if (["GOAL_CHANGE", "SCOPE_CHANGE", "DECISION_CHANGE"].includes(type)) return "PRD_THINKING";
  if (type === "CORE_FLOW_CHANGE") return "PRD_DRAFTING_CORE";
  if (type === "DETAIL_RULE_CHANGE") return "PRD_DRAFTING_DETAILS";
  return null;
}

function safeId(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

const STRING_ARRAY = { type: "array", items: { type: "string" } };
const IMPACT_ITEMS = { type: "array", items: { type: "object", additionalProperties: false, required: ["item_id", "artifact_ref", "locations", "impact_type", "reason"], properties: { item_id: { type: "string" }, artifact_ref: { type: "string" }, locations: STRING_ARRAY, impact_type: { type: ["string", "null"], enum: ["REWRITE_REQUIRED", "REVIEW_INVALIDATED", "DECISION_RECONFIRM_REQUIRED", "CONTEXT_REVALIDATION_REQUIRED", null] }, reason: { type: "string" } } } };

function contextResponseSchema(materialSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = materialSchema.properties as Record<string, unknown> | undefined;
  const informationItems = properties?.information_items;
  if (!informationItems || typeof informationItems !== "object") {
    throw new Error("material-ingest/schema.json 缺少 information_items 契约");
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["information_items", "conflicts", "remaining_questions", "structured_markdown"],
    properties: {
      information_items: strictJsonSchema(informationItems),
      conflicts: STRING_ARRAY,
      remaining_questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "source_refs"], properties: { question: { type: "string" }, source_refs: STRING_ARRAY } } },
      structured_markdown: { type: "string" },
    },
  };
}

function strictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictJsonSchema);
  if (!value || typeof value !== "object") return value;
  const output = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, strictJsonSchema(entry)]));
  const properties = output.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    output.additionalProperties = false;
    output.required = Object.keys(properties as Record<string, unknown>);
  }
  return output;
}

const PRD_THINKING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["background_card", "decision_questions"],
  properties: {
    background_card: { type: "object", additionalProperties: false, required: ["materials_read", "source_refs", "current_state", "problem", "target_users", "user_scenarios", "upstream_dependencies", "downstream_impacts", "confirmed_scope", "confirmed_out_of_scope", "conflicts", "missing_information"], properties: { materials_read: STRING_ARRAY, source_refs: STRING_ARRAY, current_state: { type: "string" }, problem: { type: "string" }, target_users: STRING_ARRAY, user_scenarios: STRING_ARRAY, upstream_dependencies: STRING_ARRAY, downstream_impacts: STRING_ARRAY, confirmed_scope: STRING_ARRAY, confirmed_out_of_scope: STRING_ARRAY, conflicts: STRING_ARRAY, missing_information: STRING_ARRAY } },
    decision_questions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["decision_id", "question", "source_refs"], properties: { decision_id: { type: "string" }, question: { type: "string" }, source_refs: STRING_ARRAY } } },
  },
} as Record<string, unknown>;

const PRD_CORE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["core_markdown"], properties: { core_markdown: { type: "string" } },
} as Record<string, unknown>;

const PRD_DETAILS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["details_markdown"], properties: { details_markdown: { type: "string" } },
} as Record<string, unknown>;

const PRD_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["review_id", "reviewed_prd_version", "issues", "summary", "passed_dimensions", "unverifiable_items"],
  properties: { review_id: { type: "string" }, reviewed_prd_version: { type: "string" }, issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["issue_id", "severity", "dimension", "location", "description", "evidence", "impact", "recommended_fix", "requires_replan"], properties: { issue_id: { type: "string" }, severity: { type: "string", enum: ["P0", "P1", "P2"] }, dimension: { type: "string", enum: ["FACT_STATUS", "SCOPE", "COMPLETENESS", "ACCEPTANCE", "DEPENDENCY", "CONSISTENCY", "OVER_DESIGN"] }, location: { type: "string" }, description: { type: "string" }, evidence: STRING_ARRAY, impact: { type: "string" }, recommended_fix: { type: "string" }, requires_replan: { type: "boolean" } } } }, summary: { type: "object", additionalProperties: false, required: ["p0_count", "p1_count", "p2_count", "recommendation"], properties: { p0_count: { type: "integer" }, p1_count: { type: "integer" }, p2_count: { type: "integer" }, recommendation: { type: "string", enum: ["PASS", "PASS_WITH_NOTES", "FIX_BEFORE_DELIVERY", "REPLAN_REQUIRED"] } } }, passed_dimensions: STRING_ARRAY, unverifiable_items: STRING_ARRAY },
} as Record<string, unknown>;

const CHANGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["change_type", "is_material_change", "confidence", "old_value", "new_value", "affected_items", "unaffected_items", "risks", "open_questions"],
  properties: { change_type: { type: "string", enum: ["SOURCE_CHANGE", "FACT_CHANGE", "GOAL_CHANGE", "SCOPE_CHANGE", "DECISION_CHANGE", "CORE_FLOW_CHANGE", "DETAIL_RULE_CHANGE", "WORDING_ONLY", "UNKNOWN"] }, is_material_change: { type: "boolean" }, confidence: { type: "number" }, old_value: { type: "string" }, new_value: { type: "string" }, affected_items: IMPACT_ITEMS, unaffected_items: IMPACT_ITEMS, risks: STRING_ARRAY, open_questions: STRING_ARRAY },
} as Record<string, unknown>;
