import * as fs from "node:fs";
import * as path from "node:path";
import { hashReplanForApproval } from "../lib/change-guards.js";
import { sha256Buffer } from "../lib/change-snapshot.js";
import type { ChangeAnalysisOutput, ChangeRequestInput, ReplanOutput } from "../lib/change-types.js";
import { PROJECT_ROOT } from "../lib/config.js";
import { MATERIAL_BUNDLE_FILE, readMaterialBundle, readMaterialContent, writeMaterialBundle, type MaterialBundleEntry } from "../lib/material-bundle.js";
import { readIngestionMaterialList, upsertMaterialIngestion } from "../lib/material-manifest.js";
import type { ContextAnalysisOutput, MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import type { PrdThinkingOutput, PrdWriteOutput, PrdReviewTemplate } from "../lib/prd-types.js";
import { contextDocumentRef, contextIndexRef, contextIndexPath, safeProjectSlug } from "../lib/project-paths.js";
import { incrementPatch, parseFrontmatter, pathToRepoRef, readJson, repoRefToPath, renderFrontmatter, writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import type { TaskState } from "../lib/types.js";
import type { AgentProvider, ChangeAnalysisAssets, ChangeReplanAssets, PrdProviderAssets, PrdProviderContext, PrdProviderPhase } from "./types.js";
import { writeStructuredMaterial } from "./structured-material.js";

/**
 * 通用工作区 Provider：负责把用户材料接入当前项目，并提供可校验的保守基线输出。
 * 真实模型可以替换输出生成部分，但不能绕过同一套 Runtime/Harness。
 */
export class WorkspaceProvider implements AgentProvider {
  readonly id: string = "workspace";
  readonly label: string = "通用项目工作区 Provider";
  readonly generationMode: AgentProvider["generationMode"] = "workspace";
  protected projectId = "default-project";

  setProjectId(projectId: string) {
    this.projectId = safeProjectSlug(projectId);
  }

  async getContextAssets(materialPath?: string, taskId = "task", taskGoal = "整理项目材料"): Promise<{
    inputPath: string;
    materialOutputPath: string;
    contextOutputPath: string;
    structuredMaterialPath: string;
  }> {
    const slug = safeSlug(taskId);
    const outputDir = this.outputDir(slug);
    const inputPath = path.join(outputDir, "material-ingest.input.json");
    const materialOutputPath = path.join(outputDir, "material-ingest.output.json");
    const contextOutputPath = path.join(outputDir, "context-maintain.analysis.json");
    const sourceDir = this.prepareSources(materialPath, taskGoal, taskId);
    const input = this.buildMaterialInput(sourceDir, taskGoal, taskId);
    const materialOutput = this.buildMaterialOutput(input);
    const contextOutput = this.buildContextOutput(input, materialOutput);
    writeJsonAtomic(inputPath, input);
    writeJsonAtomic(materialOutputPath, materialOutput);
    writeJsonAtomic(contextOutputPath, contextOutput);
    const structuredName = input.materials.some((material) => /MEETING|会议|纪要|记录/i.test(`${material.source_type} ${material.name}`))
      ? "meeting-note.md"
      : "structured-materials.md";
    const runStructuredPath = path.join(outputDir, structuredName);
    writeStructuredMaterial(
      input,
      materialOutput,
      runStructuredPath,
      PROJECT_ROOT,
      this.publishedStructuredMaterialRef(taskId, structuredName),
    );
    return { inputPath, materialOutputPath, contextOutputPath, structuredMaterialPath: runStructuredPath };
  }

  getContextReportRefs(taskId: string, structuredMaterialPath?: string) {
    const base = `repo://context-workspace/workspace/agent-runs/${safeSlug(taskId)}`;
    const name = structuredMaterialPath ? path.basename(structuredMaterialPath) : this.existingStructuredMaterialName(taskId);
    return {
      materialReportRef: `${base}/reports/material-analysis.json`,
      contextReportRef: `${base}/reports/context-analysis.json`,
      structuredMaterialRef: this.publishedStructuredMaterialRef(taskId, name),
      changeLogRef: `${base}/reports/context-change-log.json`,
    };
  }

  async getPrdAssets(taskId: string, phase: PrdProviderPhase = "REFERENCE", context: PrdProviderContext = {}): Promise<PrdProviderAssets> {
    const slug = safeSlug(taskId);
    const outputDir = this.outputDir(slug);
    const base = `repo://context-workspace/workspace/agent-runs/${slug}`;
    const prdRef = `repo://context-workspace/workspace/prd/${safeSlug(this.projectId)}-${slug}.md`;
    const reportRefs = this.getPrdReportRefs(taskId);
    const sourceRefs = this.ensurePrdSources(slug, base);
    const decisionIds = ["decision_goal", "decision_scope"];
    const thinkingPath = path.join(outputDir, "prd-thinking.json");
    const ledgerPath = path.join(outputDir, "decision-ledger.confirmed.json");
    const corePath = path.join(outputDir, "prd-write.core.json");
    const detailsPath = path.join(outputDir, "prd-write.details.json");
    const revisionPath = path.join(outputDir, "prd-write.revision.json");
    const coreCandidatePath = path.join(outputDir, "prd.core.md");
    const detailsCandidatePath = path.join(outputDir, "prd.details.md");
    const revisionCandidatePath = path.join(outputDir, "prd.revision.md");
    const reviewTemplatePath = path.join(outputDir, "prd-review.template.json");
    const prdPath = repoRefToPath(prdRef, PROJECT_ROOT);
    const currentPrd = fs.existsSync(prdPath) ? parseFrontmatter(fs.readFileSync(prdPath, "utf-8")) : null;
    const currentVersion = typeof currentPrd?.metadata.version === "string" ? currentPrd.metadata.version : null;
    const revisionVersion = currentVersion ? incrementPatch(currentVersion) : null;
    const revisionSourceRefs = stringArrayMetadata(currentPrd?.metadata.source_refs, sourceRefs);
    const revisionDecisionIds = stringArrayMetadata(currentPrd?.metadata.decision_refs, decisionIds);

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
    const core = this.buildPrdOutput(prdRef, sourceRefs, decisionIds, "CORE", "0.1.0", null, coreCandidatePath, phase === "CORE");
    const details = this.buildPrdOutput(prdRef, sourceRefs, decisionIds, "DETAILS", "0.2.0", "0.1.0", detailsCandidatePath, phase === "DETAILS");
    const revision = revisionVersion && currentVersion
      ? this.buildPrdOutput(
          prdRef,
          revisionSourceRefs,
          revisionDecisionIds,
          "REVISION",
          revisionVersion,
          currentVersion,
          revisionCandidatePath,
          phase === "REVISION",
          currentPrd?.body,
          context.revisionDecisions ?? context.userConfirmation,
        )
      : null;
    if (phase === "REVISION" && !revision) throw new Error("生成审核修订稿前必须存在当前 PRD 版本");
    const reviewedVersion = phase === "REVISION" ? revisionVersion ?? "0.2.0" : "0.2.0";
    const reviewTemplate: PrdReviewTemplate = {
      review_id: `review-${safeSlug(this.projectId)}-${slug}`,
      reviewed_prd_version: reviewedVersion,
      issues: [],
      summary: { p0_count: 0, p1_count: 0, p2_count: 0, recommendation: "PASS" },
      passed_dimensions: ["FACT_STATUS", "SCOPE", "DEPENDENCY", "CONSISTENCY"],
      unverifiable_items: ["真实业务指标需由产品经理补充"],
    };
    if (phase === "THINKING") writeJsonAtomic(thinkingPath, thinking);
    if (phase === "CORE") {
      writeJsonAtomic(ledgerPath, ledger);
      writeJsonAtomic(repoRefToPath(reportRefs.ledgerRef, PROJECT_ROOT), ledger);
      writeJsonAtomic(corePath, core);
    }
    if (phase === "DETAILS") {
      writeJsonAtomic(detailsPath, details);
      writeJsonAtomic(reviewTemplatePath, reviewTemplate);
    }
    if (phase === "REVISION" && revision) {
      writeJsonAtomic(revisionPath, revision);
      writeJsonAtomic(reviewTemplatePath, reviewTemplate);
    }
    return {
      thinkingPath,
      confirmedLedgerPath: ledgerPath,
      corePath,
      detailsPath: phase === "REVISION" ? revisionPath : detailsPath,
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

  async prepareChangeAnalysis(state: TaskState, message: string): Promise<ChangeAnalysisAssets> {
    const slug = safeSlug(state.task_id);
    const prd = await this.getPrdAssets(state.task_id);
    const reports = this.getPrdReportRefs(state.task_id);
    const indexRef = contextIndexRef(this.projectId);
    const hasContextIndex = fs.existsSync(contextIndexPath(this.projectId, PROJECT_ROOT));
    const changeId = `change-${safeSlug(this.projectId)}-${slug}`.slice(0, 80);
    const snapshotRef = `repo://context-workspace/workspace/snapshots/${changeId}/manifest.json`;
    const reportRef = `repo://context-workspace/workspace/reports/change-impact-${slug}.json`;
    const input: ChangeRequestInput = {
      request_meta: { request_id: `request-${slug}`, project_id: this.projectId, task_id: state.task_id, current_state: "CHANGE_ANALYZING", triggered_by: "USER", requested_at: new Date().toISOString() },
      change_request: { change_id: changeId, change_text: message, change_source: "USER", received_at: new Date().toISOString(), source_refs: [prd.prdRef] },
      task_snapshot: { source_state: "DELIVERED", material_version: state.material_version, context_version: state.context_version, decision_ledger_version: state.decision_ledger_version, prd_version: state.prd_version, plan_version: state.plan_version },
      artifact_refs: [prd.prdRef, reports.reviewRef, reports.ledgerRef, ...(hasContextIndex ? [indexRef] : [])],
      confirmed_decision_refs: ["decision_goal", "decision_scope"],
    };
    const analysis: ChangeAnalysisOutput = {
      mode: "ANALYZE", change_id: changeId, snapshot_ref: snapshotRef,
      change_classification: { change_type: "DETAIL_RULE_CHANGE", is_material_change: true, confidence: 0.65 },
      change_summary: { old_value: "当前已确认方案", new_value: message, source_refs: [prd.prdRef] },
      affected_items: [{ item_id: "affected-prd", artifact_ref: prd.prdRef, locations: ["需求目标与核心流程"], impact_type: "REWRITE_REQUIRED", reason: "用户提出的变化可能影响当前需求交付内容" }],
      unaffected_items: [{ item_id: "unaffected-review", artifact_ref: reports.reviewRef, locations: ["独立审核报告"], reason: "当前变化只影响 PRD 细节，不改变既有审核记录" }],
      recommended_return_state: "PRD_DRAFTING_DETAILS", risks: ["变更影响需结合业务判断确认"], open_questions: ["请确认变更是否影响目标、范围或核心流程"],
    };
    const outputDir = this.outputDir(slug);
    const inputPath = path.join(outputDir, "change-request.json");
    const analysisPath = path.join(outputDir, "change-impact.analysis.json");
    writeJsonAtomic(inputPath, input);
    writeJsonAtomic(analysisPath, analysis);
    return { inputPath, analysisPath, reportRef, changeId };
  }

  async prepareChangeReplan(state: TaskState, assets: ChangeAnalysisAssets): Promise<ChangeReplanAssets> {
    const slug = safeSlug(state.task_id);
    const reports = this.getPrdReportRefs(state.task_id);
    const planRef = `repo://context-workspace/workspace/plans/${safeSlug(this.projectId)}-${slug}-replan.json`;
    const analysisRef = assets.reportRef;
    const plan: ReplanOutput = {
      mode: "REPLAN", change_id: assets.changeId, analysis_ref: analysisRef, analysis_sha256: sha256Buffer(fs.readFileSync(repoRefToPath(analysisRef, PROJECT_ROOT))), snapshot_ref: `repo://context-workspace/workspace/snapshots/${assets.changeId}/manifest.json`,
      plan: { plan_id: `replan-${assets.changeId}`, version: "0.2.0", previous_version: state.plan_version, status: "DRAFT", recommended_return_state: "PRD_DRAFTING_DETAILS", steps: [{ step_id: "step-details", state: "PRD_DRAFTING_DETAILS", action: "根据获批变更补充 PRD 细节并重新审核", input_refs: [analysisRef], depends_on: [] }], preserved_artifacts: [reports.reviewRef], preserved_items: [{ artifact_ref: reports.reviewRef, locations: ["独立审核报告"] }], deprecated_artifacts: [], required_confirmations: ["CP-R01", "CP-P03"] },
      risks: ["未确认的业务变化不能直接覆盖现有 PRD"], open_questions: ["确认后需补充具体业务规则"],
    };
    const replanPath = path.join(this.outputDir(slug), "change-impact.replan.json");
    writeJsonAtomic(replanPath, plan);
    const approval = { change_id: assets.changeId, snapshot_ref: plan.snapshot_ref, analysis_ref: analysisRef, plan_ref: planRef, approved_plan_version: plan.plan.version, approved_plan_sha256: hashReplanForApproval(plan), approved_return_state: "PRD_DRAFTING_DETAILS", approved_prd_base_version: state.prd_version, preserved_artifact_refs: plan.plan.preserved_artifacts, deprecated_artifact_refs: [] };
    return { replanPath, planRef, approval };
  }

  private prepareSources(materialPath: string | undefined, taskGoal: string, taskId = "task"): string {
    const projectDir = path.join(PROJECT_ROOT, "context-workspace/drafts", safeSlug(this.projectId), "source-materials", safeSlug(taskId));
    fs.mkdirSync(projectDir, { recursive: true });
    if (!materialPath) {
      const existing = fs.readdirSync(projectDir).filter((name) => isSupportedFile(path.join(projectDir, name)));
      if (!existing.length) throw new Error("请提供材料目录或文件路径；当前项目还没有可分析的材料");
      return projectDir;
    }
    const resolved = path.resolve(materialPath);
    if (!fs.existsSync(resolved)) throw new Error(`材料路径不存在: ${materialPath}`);
    const draftRoot = path.resolve(projectDir);
    if ((resolved === draftRoot || resolved.startsWith(draftRoot + path.sep)) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    const files = fs.statSync(resolved).isDirectory()
      ? fs.readdirSync(resolved).map((name) => path.join(resolved, name)).filter(isSupportedFile)
      : [resolved];
    if (!files.length) throw new Error("材料目录中没有 Markdown、纯文本或 JSON 文件");
    const entries: MaterialBundleEntry[] = files.map((source) => {
      const content = fs.readFileSync(source, "utf-8");
      const metadata = parseFrontmatter(content).metadata;
      return {
        source_id: `src-${sha256Buffer(content).slice(0, 10)}`,
        original_name: path.basename(source),
        stored_name: MATERIAL_BUNDLE_FILE,
        source_type: typeof metadata.source_type === "string" ? metadata.source_type : null,
        source_owner: typeof metadata.source_owner === "string" ? metadata.source_owner : null,
        source_time: typeof metadata.source_time === "string" ? metadata.source_time : null,
        is_complete: true,
        content_bytes: Buffer.byteLength(content, "utf-8"),
        content,
      };
    });
    writeMaterialBundle(path.join(projectDir, MATERIAL_BUNDLE_FILE), entries);
    upsertMaterialIngestion(this.projectId, {
      task_id: taskId,
      task_goal: taskGoal,
      updated_at: new Date().toISOString(),
      materials: entries.map(({ content: _content, ...entry }) => entry),
    }, this.projectId);
    return projectDir;
  }

  private buildMaterialInput(sourceDir: string, taskGoal: string, taskId: string): MaterialIngestInput {
    const ingestionMaterials = readIngestionMaterialList(this.projectId, taskId, sourceDir, PROJECT_ROOT);
    if (ingestionMaterials.length) {
      const materials = ingestionMaterials.map((ingestion) => {
        const filePath = path.join(sourceDir, ingestion.stored_name);
        if (!fs.existsSync(filePath)) throw new Error(`已登记材料文件不存在: ${filePath}`);
        const content = readMaterialBundle(filePath, ingestion.source_id);
        const metadata = parseFrontmatter(content).metadata;
        const sourceId = ingestion.source_id ?? `src-${sha256Buffer(content).slice(0, 10)}`;
        const sourceOwner = typeof metadata.source_owner === "string" && metadata.source_owner ? metadata.source_owner : ingestion.source_owner ?? "user-provided";
        const sourceTime = typeof metadata.source_time === "string" && metadata.source_time
          ? metadata.source_time
          : ingestion.source_time ?? new Date(fs.statSync(filePath).mtimeMs).toISOString();
        const sourceType = typeof metadata.source_type === "string" && metadata.source_type
          ? metadata.source_type
          : ingestion.source_type ?? extensionType(ingestion.original_name);
        return { source_id: sourceId, name: ingestion.original_name, source_type: sourceType, source_owner: sourceOwner, source_time: sourceTime, content_ref: pathToRepoRef(filePath, PROJECT_ROOT), is_complete: ingestion.is_complete };
      });
      return { task_goal: taskGoal, project_id: this.projectId, workspace_slug: this.projectId, analysis_scope: { topic: this.projectId, included_source_ids: materials.map((item) => item.source_id) }, materials };
    }
    const files = fs.readdirSync(sourceDir).filter((name) => isSupportedFile(path.join(sourceDir, name))).sort();
    const materials = files.map((name) => {
      const filePath = path.join(sourceDir, name);
      const content = fs.readFileSync(filePath, "utf-8");
      const sourceId = `src-${sha256Buffer(content).slice(0, 10)}`;
      const metadata = parseFrontmatter(content).metadata;
      const sourceOwner = typeof metadata.source_owner === "string" && metadata.source_owner ? metadata.source_owner : "user-provided";
      const sourceTime = typeof metadata.source_time === "string" && metadata.source_time
        ? metadata.source_time
        : new Date(fs.statSync(filePath).mtimeMs).toISOString();
      const sourceType = typeof metadata.source_type === "string" && metadata.source_type ? metadata.source_type : extensionType(name);
      return { source_id: sourceId, name, source_type: sourceType, source_owner: sourceOwner, source_time: sourceTime, content_ref: pathToRepoRef(filePath, PROJECT_ROOT), is_complete: true };
    });
    return { task_goal: taskGoal, project_id: this.projectId, workspace_slug: this.projectId, analysis_scope: { topic: this.projectId, included_source_ids: materials.map((item) => item.source_id) }, materials };
  }

  private buildMaterialOutput(input: MaterialIngestInput): MaterialIngestOutput {
    const information_items = input.materials.map((material, index) => {
      const content = readMaterialContent(material, PROJECT_ROOT).trim();
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

  protected buildContextProposal(item: MaterialIngestOutput["information_items"][number]) {
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

  private ensurePrdSources(slug: string, base: string): string[] {
    const refs = fs.existsSync(contextIndexPath(this.projectId, PROJECT_ROOT))
      ? [contextIndexRef(this.projectId)]
      : [];
    const report = repoRefToPath(`${base}/reports/material-analysis.json`, PROJECT_ROOT);
    if (!fs.existsSync(report)) writeJsonAtomic(report, { project_id: this.projectId, note: "通用项目尚未完成材料分析，当前以 Context 索引作为输入" });
    refs.push(pathToRepoRef(report, PROJECT_ROOT));
    return refs;
  }

  private buildPrdOutput(
    prdRef: string,
    sourceRefs: string[],
    decisionIds: string[],
    phase: "CORE" | "DETAILS" | "REVISION",
    version: string,
    previousVersion: string | null,
    candidatePath: string,
    writeCandidate: boolean,
    currentBody?: string,
    revisionDecisions?: string,
  ): PrdWriteOutput {
    const headings = phase === "CORE" ? ["background", "problem", "goal", "non-goals", "target-users", "scope", "core-flow", "confirmed-decisions"] : ["background", "problem", "goal", "non-goals", "target-users", "scope", "core-flow", "confirmed-decisions", "rules", "roles", "exceptions", "acceptance"];
    const body = phase === "REVISION"
      ? `${currentBody?.trim() ?? `# ${this.projectId} 需求文档`}\n\n## 本轮审核修订\n${revisionDecisions?.trim() || "按用户确认的审核处置修订。"}`
      : phase === "CORE"
      ? `# ${this.projectId} 需求文档\n\n## 1. 背景与问题\n基于当前项目材料整理，具体问题待产品经理确认。\n\n## 2. 目标\n待确认。\n\n## 3. 本期范围与非范围\n待确认。\n\n## 4. 核心流程\n用户场景 → 核心任务 → 结果反馈。\n\n## 5. 已确认决策\n等待产品经理确认目标与范围。`
      : `# ${this.projectId} 需求文档\n\n## 1. 背景与问题\n基于当前项目材料整理，具体问题待产品经理确认。\n\n## 2. 目标\n待确认。\n\n## 3. 本期范围与非范围\n待确认。\n\n## 4. 核心流程\n用户场景 → 核心任务 → 结果反馈。\n\n## 5. 已确认决策\n等待产品经理确认目标与范围。\n\n## 功能规则\n待补充。\n\n## 角色与权限\n待补充。\n\n## 边界与异常\n待补充。\n\n## 验收标准\n待补充。`;
    if (writeCandidate) writeTextAtomic(candidatePath, `---\nid: ${safeSlug(this.projectId)}-prd\nversion: ${version}\n---\n\n${body}`);
    return { prd_artifact: { artifact_id: `prd-${safeSlug(this.projectId)}`, version, previous_version: previousVersion, phase, structured_sections: headings, markdown_ref: prdRef, content_ref: pathToRepoRef(candidatePath, PROJECT_ROOT), source_refs: sourceRefs, decision_refs: decisionIds }, coverage: { required_sections: headings, covered_sections: headings, missing_sections: [] }, unresolved_items: phase === "REVISION" ? [] : [{ item: "业务事实、目标和验收口径待确认", status: "OPEN", source_refs: sourceRefs }], unsupported_claims: [], change_summary: phase === "CORE" ? "通用项目 PRD 主体草稿" : phase === "DETAILS" ? "通用项目 PRD 细节草稿" : "根据用户审核处置决定修订 PRD" };
  }

  protected outputDir(slug: string) { const dir = path.join(PROJECT_ROOT, "runtime/provider-output", slug); fs.mkdirSync(dir, { recursive: true }); return dir; }

  protected publishedStructuredMaterialRef(taskId: string, name: string): string {
    const folder = name === "meeting-note.md" ? "meeting-notes" : "structured-materials";
    return `repo://context-workspace/workspace/projects/${safeProjectSlug(this.projectId)}/materials/${folder}/${safeSlug(taskId)}.md`;
  }

  private existingStructuredMaterialName(taskId: string): string {
    const dir = this.outputDir(safeSlug(taskId));
    if (fs.existsSync(path.join(dir, "meeting-note.md"))) return "meeting-note.md";
    const runDir = path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", safeSlug(taskId), "materials");
    return fs.existsSync(path.join(runDir, "meeting-note.md")) ? "meeting-note.md" : "structured-materials.md";
  }
}

function isSupportedFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return fs.statSync(filePath).isFile()
    && /\.(md|markdown|txt|json)$/i.test(filePath)
    && !name.startsWith(".")
    && name !== "ingest-manifest.json"
    && name !== "material-manifest.json";
}
function extensionType(name: string): string { return path.extname(name).toLowerCase() === ".json" ? "JSON" : "TEXT"; }
function safeSlug(value: string): string { const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, ""); return normalized || "default-project"; }
function stringArrayMetadata(value: string | string[] | null | undefined, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}
