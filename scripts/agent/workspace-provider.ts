import * as fs from "node:fs";
import * as path from "node:path";
import { hashReplanForApproval } from "../lib/change-guards.js";
import { sha256Buffer } from "../lib/change-snapshot.js";
import type { ChangeAnalysisOutput, ChangeRequestInput, ReplanOutput } from "../lib/change-types.js";
import { PROJECT_ROOT } from "../lib/config.js";
import type { ContextAnalysisOutput, MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import type { PrdThinkingOutput, PrdWriteOutput, PrdReviewTemplate } from "../lib/prd-types.js";
import { contextDocumentRef, contextIndexRef, contextIndexPath, contextRootPath, safeProjectSlug } from "../lib/project-paths.js";
import { parseFrontmatter, pathToRepoRef, readJson, repoRefToPath, renderFrontmatter, writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import type { TaskState } from "../lib/types.js";
import type { AgentProvider, ChangeAnalysisAssets, ChangeReplanAssets, PrdProviderAssets } from "./types.js";
import { writeStructuredMaterial } from "./structured-material.js";

/**
 * 通用工作区 Provider：负责把用户材料接入当前项目，并提供可校验的保守基线输出。
 * 真实模型可以替换输出生成部分，但不能绕过同一套 Runtime/Harness。
 */
export class WorkspaceProvider implements AgentProvider {
  readonly id = "workspace";
  readonly label = "通用项目工作区 Provider";
  private projectId = "default-project";

  setProjectId(projectId: string) {
    this.projectId = safeProjectSlug(projectId);
  }

  getContextAssets(materialPath?: string, taskId = "task", taskGoal = "整理项目材料") {
    const slug = safeSlug(taskId);
    const outputDir = this.outputDir(slug);
    const inputPath = path.join(outputDir, "material-ingest.input.json");
    const materialOutputPath = path.join(outputDir, "material-ingest.output.json");
    const contextOutputPath = path.join(outputDir, "context-maintain.analysis.json");
    const structuredMaterialPath = path.join(outputDir, "structured-materials.md");
    const sourceDir = this.prepareSources(materialPath, taskGoal);
    this.ensureProjectContext();
    const input = this.buildMaterialInput(sourceDir, taskGoal);
    const materialOutput = this.buildMaterialOutput(input);
    const contextOutput = this.buildContextOutput(input, materialOutput);
    writeJsonAtomic(inputPath, input);
    writeJsonAtomic(materialOutputPath, materialOutput);
    writeJsonAtomic(contextOutputPath, contextOutput);
    const structuredName = input.materials.some((material) => /MEETING|会议|纪要|记录/i.test(`${material.source_type} ${material.name}`))
      ? "meeting-note.md"
      : "structured-materials.md";
    const finalStructuredPath = path.join(outputDir, structuredName);
    writeStructuredMaterial(input, materialOutput, finalStructuredPath, PROJECT_ROOT);
    return { inputPath, materialOutputPath, contextOutputPath, structuredMaterialPath: finalStructuredPath };
  }

  getContextReportRefs(taskId: string, structuredMaterialPath?: string) {
    const base = `repo://context-workspace/workspace/agent-runs/${safeSlug(taskId)}`;
    const name = structuredMaterialPath ? path.basename(structuredMaterialPath) : this.existingStructuredMaterialName(taskId);
    return {
      materialReportRef: `${base}/reports/material-analysis.json`,
      contextReportRef: `${base}/reports/context-analysis.json`,
      structuredMaterialRef: `${base}/materials/${name}`,
      changeLogRef: `${base}/reports/context-change-log.json`,
    };
  }

  getPrdAssets(taskId: string): PrdProviderAssets {
    const slug = safeSlug(taskId);
    const outputDir = this.outputDir(slug);
    const base = `repo://context-workspace/workspace/agent-runs/${slug}`;
    const prdRef = `repo://context-workspace/workspace/prd/${safeSlug(this.projectId)}-${slug}.md`;
    const sourceRefs = this.ensurePrdSources(slug, base);
    const decisionIds = ["decision_goal", "decision_scope"];
    const thinkingPath = path.join(outputDir, "prd-thinking.json");
    const ledgerPath = path.join(outputDir, "decision-ledger.confirmed.json");
    const corePath = path.join(outputDir, "prd-write.core.json");
    const detailsPath = path.join(outputDir, "prd-write.details.json");
    const reviewTemplatePath = path.join(outputDir, "prd-review.template.json");

    const thinking: PrdThinkingOutput = {
      background_card: {
        materials_read: sourceRefs,
        source_refs: sourceRefs,
        current_state: "当前项目材料已接入工作区，具体业务现状以来源材料为准",
        problem: "待由产品经理确认需要解决的问题和用户价值",
        target_users: ["待从材料和用户判断中确认"],
        user_scenarios: ["待补充真实使用场景"],
        upstream_dependencies: ["待确认"],
        downstream_impacts: ["待确认"],
        confirmed_scope: [],
        confirmed_out_of_scope: [],
        conflicts: [],
        missing_information: ["需求目标、范围和关键业务判断"],
      },
      decision_ledger: [
        { decision_id: "decision_goal", question: "本次要解决的核心问题和目标是什么？", status: "PENDING", is_blocking: true, human_decision: null, source_refs: sourceRefs },
        { decision_id: "decision_scope", question: "本期范围和明确不做什么是什么？", status: "PENDING", is_blocking: true, human_decision: null, source_refs: sourceRefs },
      ],
      writable_assessment: {
        status: "NEEDS_CONFIRMATION",
        checks: { background_aligned: true, dependencies_clear: false, goal_confirmed: false, scope_confirmed: false, critical_decisions_resolved: false, no_blockers: false },
        blockers: decisionIds,
        priority_questions: [
          { decision_id: "decision_goal", question: "请确认核心问题和目标" },
          { decision_id: "decision_scope", question: "请确认本期范围和非范围" },
        ],
      },
    };
    const ledger = {
      artifact_id: `decision-ledger-${safeSlug(this.projectId)}`,
      version: "0.1.0",
      decisions: decisionIds.map((decision_id) => ({ decision_id, status: "CONFIRMED", decision: "按用户在 CP-P01 中确认的内容执行" })),
    };
    const core = this.buildPrdOutput(prdRef, sourceRefs, decisionIds, "CORE", "0.1.0", null, corePath);
    const details = this.buildPrdOutput(prdRef, sourceRefs, decisionIds, "DETAILS", "0.2.0", "0.1.0", detailsPath);
    const reviewTemplate: PrdReviewTemplate = {
      review_id: `review-${safeSlug(this.projectId)}-${slug}`,
      reviewed_prd_version: "0.2.0",
      issues: [],
      summary: { p0_count: 0, p1_count: 0, p2_count: 0, recommendation: "PASS" },
      passed_dimensions: ["FACT_STATUS", "SCOPE", "DEPENDENCY", "CONSISTENCY"],
      unverifiable_items: ["真实业务指标需由产品经理补充"],
    };
    writeJsonAtomic(thinkingPath, thinking);
    writeJsonAtomic(ledgerPath, ledger);
    writeJsonAtomic(corePath, core);
    writeJsonAtomic(detailsPath, details);
    writeJsonAtomic(reviewTemplatePath, reviewTemplate);
    return {
      thinkingPath,
      confirmedLedgerPath: ledgerPath,
      corePath,
      detailsPath,
      reviewTemplatePath,
      p01: {
        confirmation_type: "DECISION_AND_WRITABLE_STATUS",
        resolution: "CONFIRM_WRITABLE",
        writable_status: true,
        confirmed_decision_ids: decisionIds,
        decisions: decisionIds.map((decision_id) => ({ decision_id, status: "CONFIRMED", human_decision: "由产品经理确认" })),
        reason: "请确认核心问题、目标和范围后生成通用 PRD 主体",
      },
      p02: {
        confirmation_type: "SCOPE_AND_CORE_FLOW",
        resolution: "APPROVE_CORE",
        approved_core_version: "0.1.0",
        approved_scope: ["用户明确确认的本期范围"],
        approved_out_of_scope: ["尚未确认的扩展能力"],
        approved_core_flow: ["用户场景 → 核心任务 → 结果反馈"],
        reason: "主体结构与当前确认范围一致，允许补充细节",
      },
      p03: {
        confirmation_type: "REVIEW_DISPOSITION",
        resolution: "ACCEPT_AND_DELIVER",
        disposition: "ACCEPT_WITH_NOTES",
        accepted_review_id: reviewTemplate.review_id,
        review_summary: reviewTemplate.summary,
        accepted_p2_issue_ids: [],
        reason: "审核无阻塞项，未核实业务内容保留为待办",
      },
      prdRef,
    };
  }

  getPrdReportRefs(taskId: string) {
    const base = `repo://context-workspace/workspace/agent-runs/${safeSlug(taskId)}`;
    return { thinkingRef: `${base}/reports/prd-thinking.json`, ledgerRef: `${base}/decisions/decision-ledger.json`, reviewRef: `${base}/reports/prd-review.json` };
  }

  prepareChangeAnalysis(state: TaskState, message: string): ChangeAnalysisAssets {
    const slug = safeSlug(state.task_id);
    const prd = this.getPrdAssets(state.task_id);
    const reports = this.getPrdReportRefs(state.task_id);
    const indexRef = contextIndexRef(this.projectId);
    const changeId = `change-${safeSlug(this.projectId)}-${slug}`.slice(0, 80);
    const snapshotRef = `repo://context-workspace/workspace/snapshots/${changeId}/manifest.json`;
    const reportRef = `repo://context-workspace/workspace/reports/change-impact-${slug}.json`;
    const input: ChangeRequestInput = {
      request_meta: { request_id: `request-${slug}`, project_id: this.projectId, task_id: state.task_id, current_state: "CHANGE_ANALYZING", triggered_by: "USER", requested_at: new Date().toISOString() },
      change_request: { change_id: changeId, change_text: message, change_source: "USER", received_at: new Date().toISOString(), source_refs: [prd.prdRef] },
      task_snapshot: { source_state: "DELIVERED", material_version: state.material_version, context_version: state.context_version, decision_ledger_version: state.decision_ledger_version, prd_version: state.prd_version, plan_version: state.plan_version },
      artifact_refs: [prd.prdRef, reports.reviewRef, reports.ledgerRef, indexRef],
      confirmed_decision_refs: ["decision_goal", "decision_scope"],
    };
    const analysis: ChangeAnalysisOutput = {
      mode: "ANALYZE", change_id: changeId, snapshot_ref: snapshotRef,
      change_classification: { change_type: "DETAIL_RULE_CHANGE", is_material_change: true, confidence: 0.65 },
      change_summary: { old_value: "当前已确认方案", new_value: message, source_refs: [prd.prdRef] },
      affected_items: [{ item_id: "affected-prd", artifact_ref: prd.prdRef, locations: ["需求目标与核心流程"], impact_type: "REWRITE_REQUIRED", reason: "用户提出的变化可能影响当前需求交付内容" }],
      unaffected_items: [{ item_id: "unaffected-context-index", artifact_ref: indexRef, locations: ["Context 索引"], reason: "仅凭当前变化不能推断稳定 Context 需要改变" }],
      recommended_return_state: "PRD_DRAFTING_DETAILS", risks: ["变更影响需结合业务判断确认"], open_questions: ["请确认变更是否影响目标、范围或核心流程"],
    };
    const outputDir = this.outputDir(slug);
    const inputPath = path.join(outputDir, "change-request.json");
    const analysisPath = path.join(outputDir, "change-impact.analysis.json");
    writeJsonAtomic(inputPath, input);
    writeJsonAtomic(analysisPath, analysis);
    return { inputPath, analysisPath, reportRef, changeId };
  }

  prepareChangeReplan(state: TaskState, assets: ChangeAnalysisAssets): ChangeReplanAssets {
    const slug = safeSlug(state.task_id);
    const planRef = `repo://context-workspace/workspace/plans/${safeSlug(this.projectId)}-${slug}-replan.json`;
    const analysisRef = assets.reportRef;
    const plan: ReplanOutput = {
      mode: "REPLAN", change_id: assets.changeId, analysis_ref: analysisRef, analysis_sha256: sha256Buffer(fs.readFileSync(repoRefToPath(analysisRef, PROJECT_ROOT))), snapshot_ref: `repo://context-workspace/workspace/snapshots/${assets.changeId}/manifest.json`,
      plan: { plan_id: `replan-${assets.changeId}`, version: "0.2.0", previous_version: state.plan_version, status: "DRAFT", recommended_return_state: "PRD_DRAFTING_DETAILS", steps: [{ step_id: "step-details", state: "PRD_DRAFTING_DETAILS", action: "根据获批变更补充 PRD 细节并重新审核", input_refs: [analysisRef], depends_on: [] }], preserved_artifacts: [contextIndexRef(this.projectId)], preserved_items: [{ artifact_ref: contextIndexRef(this.projectId), locations: ["全部索引"] }], deprecated_artifacts: [], required_confirmations: ["CP-R01", "CP-P03"] },
      risks: ["未确认的业务变化不能直接覆盖现有 PRD"], open_questions: ["确认后需补充具体业务规则"],
    };
    const replanPath = path.join(this.outputDir(slug), "change-impact.replan.json");
    writeJsonAtomic(replanPath, plan);
    const approval = { change_id: assets.changeId, snapshot_ref: plan.snapshot_ref, analysis_ref: analysisRef, plan_ref: planRef, approved_plan_version: plan.plan.version, approved_plan_sha256: hashReplanForApproval(plan), approved_return_state: "PRD_DRAFTING_DETAILS", approved_prd_base_version: state.prd_version, preserved_artifact_refs: plan.plan.preserved_artifacts, deprecated_artifact_refs: [] };
    return { replanPath, planRef, approval };
  }

  private prepareSources(materialPath: string | undefined, taskGoal: string): string {
    const projectDir = path.join(PROJECT_ROOT, "context-workspace/drafts", safeSlug(this.projectId), "source-materials");
    fs.mkdirSync(projectDir, { recursive: true });
    if (!materialPath) {
      const existing = fs.readdirSync(projectDir).filter((name) => isSupportedFile(path.join(projectDir, name)));
      if (!existing.length) throw new Error("请提供材料目录或文件路径；当前项目还没有可分析的材料");
      return projectDir;
    }
    const resolved = path.resolve(materialPath);
    if (!fs.existsSync(resolved)) throw new Error(`材料路径不存在: ${materialPath}`);
    const draftRoot = path.resolve(projectDir);
    if (resolved.startsWith(draftRoot + path.sep) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    const files = fs.statSync(resolved).isDirectory()
      ? fs.readdirSync(resolved).map((name) => path.join(resolved, name)).filter(isSupportedFile)
      : [resolved];
    if (!files.length) throw new Error("材料目录中没有 Markdown、纯文本或 JSON 文件");
    for (const source of files) {
      const target = path.join(projectDir, path.basename(source));
      writeTextAtomic(target, fs.readFileSync(source, "utf-8"));
    }
    writeJsonAtomic(path.join(projectDir, ".ingest-meta.json"), { project_id: this.projectId, task_goal: taskGoal, updated_at: new Date().toISOString() });
    return projectDir;
  }

  private buildMaterialInput(sourceDir: string, taskGoal: string): MaterialIngestInput {
    const inlineMetadata = readInlineMetadata(sourceDir);
    const files = fs.readdirSync(sourceDir).filter((name) => isSupportedFile(path.join(sourceDir, name))).sort();
    const materials = files.map((name) => {
      const filePath = path.join(sourceDir, name);
      const content = fs.readFileSync(filePath, "utf-8");
      const sourceId = `src-${sha256Buffer(content).slice(0, 10)}`;
      const metadata = parseFrontmatter(content).metadata;
      const inline = inlineMetadata[name];
      const sourceOwner = typeof metadata.source_owner === "string" && metadata.source_owner ? metadata.source_owner : inline?.source_owner ?? "user-provided";
      const sourceTime = typeof metadata.source_time === "string" && metadata.source_time
        ? metadata.source_time
        : inline?.source_time ?? new Date(fs.statSync(filePath).mtimeMs).toISOString();
      const sourceType = typeof metadata.source_type === "string" && metadata.source_type ? metadata.source_type : inline?.source_type ?? extensionType(name);
      return { source_id: sourceId, name: inline?.original_name ?? name, source_type: sourceType, source_owner: sourceOwner, source_time: sourceTime, content_ref: pathToRepoRef(filePath, PROJECT_ROOT), is_complete: inline?.is_complete ?? true };
    });
    return { task_goal: taskGoal, project_id: this.projectId, workspace_slug: this.projectId, analysis_scope: { topic: this.projectId, included_source_ids: materials.map((item) => item.source_id) }, materials };
  }

  private buildMaterialOutput(input: MaterialIngestInput): MaterialIngestOutput {
    const information_items = input.materials.map((material, index) => {
      const content = fs.readFileSync(repoRefToPath(material.content_ref, PROJECT_ROOT), "utf-8").trim();
      const quote = content.slice(0, 240) || "（空材料）";
      const text = `${material.name}\n${content}`;
      const isFeedback = /反馈|用户|抱怨|不用了|希望|建议|问题|诉求/i.test(text);
      const isConfirmed = !isFeedback && (/确认|结论|决定|已确定|现状|业务约束|必须|不可/i.test(text) || /MEETING|PRODUCT|RULE|DECISION|CONSTRAINT/i.test(material.source_type));
      const information_type = isFeedback
        ? "USER_FEEDBACK" as const
        : isConfirmed && /确认|结论|决定|已确定|决策/i.test(text)
          ? "CONFIRMED_DECISION" as const
          : isConfirmed ? "FACT" as const : "OBSERVATION" as const;
      return { item_id: `item-${index + 1}-${material.source_id}`, content: content || "（空材料）", information_type, maturity: isConfirmed ? "CONFIRMED" as const : "RAW" as const, source_refs: [material.source_id], evidence: [{ source_id: material.source_id, location: "文件原文" , quote }], target_layer: isConfirmed ? "CONTEXT" as const : "DRAFTS" as const, confidence: isConfirmed ? 0.85 : 0.6, requires_confirmation: isConfirmed };
    });
    return { material_records: input.materials.map((material) => ({ source_id: material.source_id, topic: input.analysis_scope.topic, processing_status: "PROCESSED", missing_metadata: [] })), information_items, processing_summary: { material_count: input.materials.length, processed_count: input.materials.length, failed_count: 0, information_item_count: information_items.length }, failed_materials: [] };
  }

  private buildContextOutput(input: MaterialIngestInput, output: MaterialIngestOutput): ContextAnalysisOutput {
    const feedbackCount = output.information_items.filter((item) => item.information_type === "USER_FEEDBACK").length;
    const proposals = output.information_items
      .filter((item) => item.maturity === "CONFIRMED" && item.information_type !== "USER_FEEDBACK")
      .map((item) => this.buildContextProposal(item));
    return {
      action: "ANALYZE",
      update_proposals: proposals,
      conflicts: [],
      stale_items: [],
      index_issues: [],
      auto_actions: [],
      remaining_questions: [
        ...(feedbackCount ? [{ question: "用户反馈中的具体诉求、场景和期望结果需要产品经理确认", source_refs: output.information_items.filter((item) => item.information_type === "USER_FEEDBACK").flatMap((item) => item.source_refs) }] : []),
        ...output.information_items.filter((item) => item.information_type === "OPEN_QUESTION").map((item) => ({ question: item.content, source_refs: item.source_refs })),
      ],
    };
  }

  private buildContextProposal(item: MaterialIngestOutput["information_items"][number]) {
    const relativePath = item.information_type === "FACT"
      ? `product/${safeSlug(item.item_id)}.md`
      : `business-rules/${safeSlug(item.item_id)}.md`;
    const targetRef = contextDocumentRef(this.projectId, relativePath);
    const targetPath = repoRefToPath(targetRef, PROJECT_ROOT);
    const existing = fs.existsSync(targetPath) ? parseFrontmatter(fs.readFileSync(targetPath, "utf-8")) : null;
    const candidatePath = path.join(this.outputDir(safeSlug(item.item_id)), "context-candidate.md");
    const title = item.information_type === "FACT" ? "产品现状候选" : "已确认业务规则候选";
    const id = String(existing?.metadata.id ?? safeSlug(item.item_id));
    const baseVersion = String(existing?.metadata.version ?? "0.0.0");
    writeTextAtomic(candidatePath, renderFrontmatter({ id, version: existing ? baseVersion : "0.1.0", status: "active" }, `# ${title}\n\n${item.content}`));
    return {
      proposal_id: `proposal-${safeSlug(item.item_id)}`,
      action: existing ? "UPDATE_CONTEXT" as const : "PROMOTE_TO_CONTEXT" as const,
      target_ref: targetRef,
      item_id: item.item_id,
      current_value: null,
      proposed_value: item.content,
      source_refs: item.source_refs,
      relationship: "SUPPORTS" as const,
      risk_level: "MEDIUM" as const,
      requires_confirmation: true,
      impact_if_applied: "后续任务可将这条已确认材料作为稳定业务上下文读取",
      impact_if_ignored: "本次只保留材料和分析结果，不更新稳定 Context",
      base_version: baseVersion,
      content_ref: pathToRepoRef(candidatePath, PROJECT_ROOT),
    };
  }

  private ensureProjectContext() {
    const root = contextRootPath(this.projectId, PROJECT_ROOT);
    fs.mkdirSync(root, { recursive: true });
    for (const group of ["product", "users", "business-rules", "glossary"]) fs.mkdirSync(path.join(root, group), { recursive: true });
  }

  private ensureProjectIndex() {
    this.ensureProjectContext();
    const indexPath = contextIndexPath(this.projectId, PROJECT_ROOT);
    if (!fs.existsSync(indexPath)) {
      writeTextAtomic(indexPath, renderFrontmatter({ version: "0.1.0", updated: new Date().toISOString().slice(0, 10), project: this.projectId }, "# Context 索引\n\n> 此索引由 `scripts/update-index.ts` 根据稳定 Context 文件生成。"));
    }
  }

  private ensurePrdSources(slug: string, base: string): string[] {
    this.ensureProjectIndex();
    const refs = [contextIndexRef(this.projectId)];
    const report = repoRefToPath(`${base}/reports/material-analysis.json`, PROJECT_ROOT);
    if (!fs.existsSync(report)) writeJsonAtomic(report, { project_id: this.projectId, note: "通用项目尚未完成材料分析，当前以 Context 索引作为输入" });
    refs.push(pathToRepoRef(report, PROJECT_ROOT));
    return refs;
  }

  private buildPrdOutput(prdRef: string, sourceRefs: string[], decisionIds: string[], phase: "CORE" | "DETAILS", version: string, previousVersion: string | null, candidatePath: string): PrdWriteOutput {
    const headings = phase === "CORE" ? ["background", "problem", "goal", "non-goals", "target-users", "scope", "core-flow", "confirmed-decisions"] : ["background", "problem", "goal", "non-goals", "target-users", "scope", "core-flow", "confirmed-decisions", "rules", "roles", "exceptions", "acceptance"];
    const body = phase === "CORE"
      ? `# ${this.projectId} 需求文档\n\n## 1. 背景与问题\n基于当前项目材料整理，具体问题待产品经理确认。\n\n## 2. 目标\n待确认。\n\n## 3. 本期范围与非范围\n待确认。\n\n## 4. 核心流程\n用户场景 → 核心任务 → 结果反馈。\n\n## 5. 已确认决策\n等待产品经理确认目标与范围。`
      : `# ${this.projectId} 需求文档\n\n## 1. 背景与问题\n基于当前项目材料整理，具体问题待产品经理确认。\n\n## 2. 目标\n待确认。\n\n## 3. 本期范围与非范围\n待确认。\n\n## 4. 核心流程\n用户场景 → 核心任务 → 结果反馈。\n\n## 5. 已确认决策\n等待产品经理确认目标与范围。\n\n## 功能规则\n待补充。\n\n## 角色与权限\n待补充。\n\n## 边界与异常\n待补充。\n\n## 验收标准\n待补充。`;
    writeTextAtomic(candidatePath, `---\nid: ${safeSlug(this.projectId)}-prd\nversion: ${version}\n---\n\n${body}`);
    return { prd_artifact: { artifact_id: `prd-${safeSlug(this.projectId)}`, version, previous_version: previousVersion, phase, structured_sections: headings, markdown_ref: prdRef, content_ref: pathToRepoRef(candidatePath, PROJECT_ROOT), source_refs: sourceRefs, decision_refs: decisionIds }, coverage: { required_sections: headings, covered_sections: headings, missing_sections: [] }, unresolved_items: [{ item: "业务事实、目标和验收口径待确认", status: "OPEN", source_refs: sourceRefs }], unsupported_claims: [], change_summary: phase === "CORE" ? "通用项目 PRD 主体草稿" : "通用项目 PRD 细节草稿" };
  }

  private outputDir(slug: string) { const dir = path.join(PROJECT_ROOT, "runtime/provider-output", slug); fs.mkdirSync(dir, { recursive: true }); return dir; }

  private existingStructuredMaterialName(taskId: string): string {
    const dir = this.outputDir(safeSlug(taskId));
    return fs.existsSync(path.join(dir, "meeting-note.md")) ? "meeting-note.md" : "structured-materials.md";
  }
}

function readInlineMetadata(sourceDir: string): Record<string, {
  original_name: string;
  source_type: string | null;
  source_owner: string | null;
  source_time: string | null;
  is_complete: boolean;
}> {
  const metadataPath = path.join(sourceDir, ".inline-materials.json");
  if (!fs.existsSync(metadataPath)) return {};
  const raw = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { materials?: Array<Record<string, unknown>> };
  return Object.fromEntries((raw.materials ?? []).flatMap((item) => {
    if (typeof item.stored_name !== "string" || typeof item.original_name !== "string") return [];
    return [[item.stored_name, {
      original_name: item.original_name,
      source_type: typeof item.source_type === "string" ? item.source_type : null,
      source_owner: typeof item.source_owner === "string" ? item.source_owner : null,
      source_time: typeof item.source_time === "string" ? item.source_time : null,
      is_complete: item.is_complete !== false,
    }]];
  }));
}

function isSupportedFile(filePath: string): boolean { return fs.statSync(filePath).isFile() && /\.(md|markdown|txt|json)$/i.test(filePath) && !path.basename(filePath).startsWith("."); }
function extensionType(name: string): string { return path.extname(name).toLowerCase() === ".json" ? "JSON" : "TEXT"; }
function safeSlug(value: string): string { const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, ""); return normalized || "default-project"; }
