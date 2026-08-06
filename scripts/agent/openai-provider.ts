import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Buffer } from "../lib/change-snapshot.js";
import type { ChangeAnalysisOutput, ChangeType } from "../lib/change-types.js";
import { PROJECT_ROOT } from "../lib/config.js";
import type { MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import { loadLocalEnv } from "../lib/env.js";
import type { PrdReviewTemplate, PrdThinkingOutput, PrdWriteOutput } from "../lib/prd-types.js";
import { parseFrontmatter, pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import type { TaskState } from "../lib/types.js";
import type { AgentProvider, ChangeAnalysisAssets, PrdProviderAssets, PrdProviderContext, PrdProviderPhase } from "./types.js";
import { OpenAIResponsesClient } from "./openai-client.js";
import type { StructuredModelClient } from "./model-client.js";
import { WorkspaceProvider } from "./workspace-provider.js";

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
  review: PrdReviewTemplate;
}

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

  constructor(private readonly client: StructuredModelClient, private readonly model: string, providerId = client.providerId, label?: string) {
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
      content: fs.readFileSync(repoRefToPath(material.content_ref, PROJECT_ROOT), "utf-8"),
    }));
    const generated = await this.client.generateJson<ContextModelOutput>({
      name: "context_analysis",
      schema: CONTEXT_SCHEMA,
      instructions: CONTEXT_INSTRUCTIONS,
      content: { task_goal: taskGoal, project_id: this.projectId, sources },
    });
    const materialOutput = normalizeMaterialOutput(input, generated.information_items);
    const proposals = materialOutput.information_items
      .filter((item) => item.requires_confirmation && item.target_layer === "CONTEXT")
      .map((item) => this.buildContextProposal(item));
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
    const artifactRef = this.publishedStructuredMaterialRef(taskId, path.basename(assets.structuredMaterialPath));
    writeTextAtomic(assets.structuredMaterialPath, ensureStructuredMaterial(generated.structured_markdown, input, artifactRef));
    return assets;
  }

  async getPrdAssets(taskId: string, phase: PrdProviderPhase = "REFERENCE", context: PrdProviderContext = {}): Promise<PrdProviderAssets> {
    const assets = await super.getPrdAssets(taskId, phase, context);
    const outputDir = this.outputDir(taskId);
    const thinkingPath = path.join(outputDir, "openai-prd-thinking.json");
    const corePath = path.join(outputDir, "openai-prd-core.json");
    const detailsPath = path.join(outputDir, "openai-prd-details.json");

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
    if (fs.existsSync(detailsPath)) applyPrdDetails(readJson<PrdDetailsModelOutput>(detailsPath), assets, this.projectId);
    return assets;
  }

  async prepareChangeAnalysis(state: TaskState, message: string): Promise<ChangeAnalysisAssets> {
    const assets = await super.prepareChangeAnalysis(state, message);
    const input = readJson<Record<string, unknown>>(assets.inputPath);
    const artifactContents = readArtifactContents((input.artifact_refs as string[] | undefined) ?? []);
    const generated = await this.client.generateJson<ChangeModelOutput>({
      name: "change_analysis",
      schema: CHANGE_SCHEMA,
      instructions: CHANGE_INSTRUCTIONS,
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
    const sourceRefs = readJson<PrdThinkingOutput>(assets.thinkingPath).background_card.source_refs;
    const sources = readArtifactContents(sourceRefs);
    return await this.client.generateJson<PrdThinkingModelOutput>({
      name: "prd_thinking",
      schema: PRD_THINKING_SCHEMA,
      instructions: PRD_THINKING_INSTRUCTIONS,
      content: { project_id: this.projectId, sources },
    });
  }

  private async generatePrdCore(assets: PrdProviderAssets, userConfirmation?: string): Promise<PrdCoreModelOutput> {
    const thinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
    return await this.client.generateJson<PrdCoreModelOutput>({
      name: "prd_core",
      schema: PRD_CORE_SCHEMA,
      instructions: PRD_CORE_INSTRUCTIONS,
      content: { project_id: this.projectId, thinking, user_confirmation: userConfirmation ?? "" },
    });
  }

  private async generatePrdDetails(assets: PrdProviderAssets, userConfirmation?: string): Promise<PrdDetailsModelOutput> {
    const core = readJson<PrdWriteOutput>(assets.corePath);
    const coreMarkdown = fs.readFileSync(repoRefToPath(core.prd_artifact.content_ref, PROJECT_ROOT), "utf-8");
    return await this.client.generateJson<PrdDetailsModelOutput>({
      name: "prd_details_review",
      schema: PRD_DETAILS_SCHEMA,
      instructions: PRD_DETAILS_INSTRUCTIONS,
      content: { project_id: this.projectId, core_markdown: coreMarkdown, user_confirmation: userConfirmation ?? "" },
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
  const thinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
  const decisionIds = thinking.decision_ledger.map((item) => item.decision_id);
  const details = readJson<PrdWriteOutput>(assets.detailsPath);
  writeTextAtomic(repoRefToPath(details.prd_artifact.content_ref, PROJECT_ROOT), withPrdFrontmatter(generated.details_markdown, projectId, "0.2.0"));
  details.prd_artifact.decision_refs = decisionIds;
  writeJsonAtomic(assets.detailsPath, details);
  const review = { ...generated.review, reviewed_prd_version: "0.2.0" };
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
  const heading = body.startsWith("# ") ? body : `# 结构化材料整理稿\n\n${body}`;
  return `${heading}\n\n## 原文保留说明\n\n原始材料已由 Runtime 登记到 \`context-workspace/drafts/\`。本整理稿不替换原文，也不把未确认内容当作产品决策。\n\n- 任务目标：${input.task_goal}\n- 产物引用：${artifactRef}\n`;
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

const CONTEXT_INSTRUCTIONS = `你是 material-ingest 与 context-maintain 的生成层。只依据输入原文提取信息，逐字 evidence.quote 必须真实出现在对应来源。用户反馈、建议、假设和问题不得标记为 CONFIRMED。只有原文明确陈述为现状、约束或已作出的决策时才可 target_layer=CONTEXT，且必须 requires_confirmation=true。输出中文整理稿，保留不确定性，不生成 PRD。`;
const PRD_THINKING_INSTRUCTIONS = `你是 prd-thinking 的生成层。只依据提供的 Context 和材料生成背景卡，并提出 1 到 3 个必须由产品经理回答的阻塞决策问题。不能输出 PRD 正文，不能替产品经理决定价值、优先级、目标或范围。`;
const PRD_CORE_INSTRUCTIONS = `你是 prd-write/CORE 的生成层。依据已经过 CP-P01 确认的写前分析生成 Markdown。只包含背景与问题、目标、非目标、目标用户、本期范围、核心流程和已确认决策；不得包含功能细节、角色与权限、边界与异常或验收标准。没有依据的内容明确标记待确认。`;
const PRD_DETAILS_INSTRUCTIONS = `你是 prd-write/DETAILS 与独立 prd-review 的生成层。保留 CORE 全部内容并补充功能规则、角色与权限、边界与异常、验收标准。没有依据的内容明确标记待确认。随后只读审核该 DETAILS，不得修改正文；审核问题计数必须与 summary 一致。`;
const CHANGE_INSTRUCTIONS = `你是 change-impact/ANALYZE 的生成层。比较变更请求和当前业务产物，只列受影响项、保留项、风险和问题，不修改原文。affected_items 和 unaffected_items 的 artifact_ref 必须来自输入 artifacts。无法判断时使用 UNKNOWN，不能擅自扩大重规划范围。`;

const STRING_ARRAY = { type: "array", items: { type: "string" } };
const IMPACT_ITEMS = { type: "array", items: { type: "object", additionalProperties: false, required: ["item_id", "artifact_ref", "locations", "impact_type", "reason"], properties: { item_id: { type: "string" }, artifact_ref: { type: "string" }, locations: STRING_ARRAY, impact_type: { type: ["string", "null"], enum: ["REWRITE_REQUIRED", "REVIEW_INVALIDATED", "DECISION_RECONFIRM_REQUIRED", "CONTEXT_REVALIDATION_REQUIRED", null] }, reason: { type: "string" } } } };

const CONTEXT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["information_items", "conflicts", "remaining_questions", "structured_markdown"],
  properties: {
    information_items: { type: "array", items: { type: "object", additionalProperties: false, required: ["item_id", "content", "information_type", "maturity", "source_refs", "evidence", "target_layer", "confidence", "requires_confirmation"], properties: {
      item_id: { type: "string" }, content: { type: "string" }, information_type: { type: "string", enum: ["USER_FEEDBACK", "OBSERVATION", "FACT", "DATA", "OPINION", "PROPOSAL", "CONFIRMED_DECISION", "OPEN_QUESTION", "DEPRECATED_CONTENT"] }, maturity: { type: "string", enum: ["RAW", "UNCONFIRMED", "CONFIRMED", "SUPERSEDED", "ARCHIVED"] }, source_refs: STRING_ARRAY, evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["source_id", "location", "quote"], properties: { source_id: { type: "string" }, location: { type: "string" }, quote: { type: "string" } } } }, target_layer: { type: "string", enum: ["DRAFTS", "WORKSPACE", "CONTEXT"] }, confidence: { type: "number" }, requires_confirmation: { type: "boolean" },
    } } },
    conflicts: STRING_ARRAY,
    remaining_questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "source_refs"], properties: { question: { type: "string" }, source_refs: STRING_ARRAY } } },
    structured_markdown: { type: "string" },
  },
} as Record<string, unknown>;

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
  type: "object", additionalProperties: false, required: ["details_markdown", "review"],
  properties: {
    details_markdown: { type: "string" },
    review: { type: "object", additionalProperties: false, required: ["review_id", "reviewed_prd_version", "issues", "summary", "passed_dimensions", "unverifiable_items"], properties: { review_id: { type: "string" }, reviewed_prd_version: { type: "string" }, issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["issue_id", "severity", "dimension", "location", "description", "evidence", "impact", "recommended_fix", "requires_replan"], properties: { issue_id: { type: "string" }, severity: { type: "string", enum: ["P0", "P1", "P2"] }, dimension: { type: "string" }, location: { type: "string" }, description: { type: "string" }, evidence: STRING_ARRAY, impact: { type: "string" }, recommended_fix: { type: "string" }, requires_replan: { type: "boolean" } } } }, summary: { type: "object", additionalProperties: false, required: ["p0_count", "p1_count", "p2_count", "recommendation"], properties: { p0_count: { type: "integer" }, p1_count: { type: "integer" }, p2_count: { type: "integer" }, recommendation: { type: "string", enum: ["PASS", "PASS_WITH_NOTES", "FIX_BEFORE_DELIVERY", "REPLAN_REQUIRED"] } } }, passed_dimensions: STRING_ARRAY, unverifiable_items: STRING_ARRAY } },
  },
} as Record<string, unknown>;

const CHANGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["change_type", "is_material_change", "confidence", "old_value", "new_value", "affected_items", "unaffected_items", "risks", "open_questions"],
  properties: { change_type: { type: "string", enum: ["SOURCE_CHANGE", "FACT_CHANGE", "GOAL_CHANGE", "SCOPE_CHANGE", "DECISION_CHANGE", "CORE_FLOW_CHANGE", "DETAIL_RULE_CHANGE", "WORDING_ONLY", "UNKNOWN"] }, is_material_change: { type: "boolean" }, confidence: { type: "number" }, old_value: { type: "string" }, new_value: { type: "string" }, affected_items: IMPACT_ITEMS, unaffected_items: IMPACT_ITEMS, risks: STRING_ARRAY, open_questions: STRING_ARRAY },
} as Record<string, unknown>;
