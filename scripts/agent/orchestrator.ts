import * as fs from "node:fs";
import * as path from "node:path";
import { applyContextActions } from "../apply-context-actions.js";
import { applyPrdArtifact } from "../apply-prd-artifact.js";
import { applyApprovedReplan } from "../apply-replan.js";
import { createTaskChangeSnapshot } from "../create-change-snapshot.js";
import { finalizePrdDelivery } from "../finalize-prd-delivery.js";
import {
  createConfirmation,
  resolveConfirmation,
} from "../lib/confirmation-runtime.js";
import {
  getActiveConfirmation,
  loadStates,
  PROJECT_ROOT,
  readPendingConfirmations,
  readTaskState,
  writeTaskState,
} from "../lib/config.js";
import type { ContextAnalysisOutput, ContextProposal } from "../lib/context-types.js";
import type { PrdReviewOutput, PrdThinkingOutput, PrdWriteOutput } from "../lib/prd-types.js";
import type { ChangeAnalysisOutput } from "../lib/change-types.js";
import { parseFrontmatter, pathToRepoRef, readJson, renderFrontmatter, repoRefToPath, writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import { loadLocalEnv } from "../lib/env.js";
import { contextIndexRef, contextRootPath } from "../lib/project-paths.js";
import { assertTransition } from "../lib/state-runtime.js";
import { createTask, updateTask } from "../lib/task-runtime.js";
import type { ConfirmationRecord, StateId, TaskState } from "../lib/types.js";
import { recordChangeAnalysis } from "../record-change-analysis.js";
import { recordConfirmedDecisions } from "../record-confirmed-decisions.js";
import { recordContextAnalysis } from "../record-context-analysis.js";
import { recordPrdReview } from "../record-prd-review.js";
import { recordPrdThinking } from "../record-prd-thinking.js";
import { recordReplan } from "../record-replan.js";
import { registerMaterials } from "../register-materials.js";
import { updateMaterialIngestionArtifact } from "../lib/material-manifest.js";
import { restoreCancelledChange } from "../restore-change-snapshot.js";
import { WorkspaceProvider } from "./workspace-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OpenAICompatibleClient } from "./openai-compatible-client.js";
import { AnthropicMessagesClient } from "./anthropic-client.js";
import type {
  AgentArtifact,
  AgentIntent,
  AgentProvider,
  AgentResponse,
  HandleMessageOptions,
} from "./types.js";

const WAITING_STATES = new Set<StateId>([
  "WAITING_RESUME_CHOICE",
  "WAITING_INTENT_CLARIFICATION",
  "WAITING_MATERIAL_REPROCESS_CONFIRM",
  "WAITING_CONTEXT_CONFIRM",
  "WAITING_DECISION_CONFIRM",
  "WAITING_SCOPE_CONFIRM",
  "WAITING_REVIEW_DECISION",
  "WAITING_REPLAN_CONFIRM",
]);

export class AgentOrchestrator {
  constructor(private readonly provider: AgentProvider = defaultProvider()) {}

  async handleMessage(message: string, options: HandleMessageOptions = {}): Promise<AgentResponse> {
    const normalized = message.trim();
    if (!normalized) return this.blocked("请输入你希望整理的材料、要准备的 PRD，或要修改的内容。", options);

    try {
      let state = readTaskState();
      if (options.taskId && state && state.task_id !== options.taskId) {
        if (["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(state.current_state)) {
          state = this.initializeTask(normalized, options.taskId, options.sessionId, options.projectId ?? state.project_id, true);
        } else {
          throw new Error(`当前运行任务是 ${state.task_id}，不是 ${options.taskId}`);
        }
      }
      if (state && options.projectId && options.projectId.trim().toLowerCase() !== state.project_id) {
        throw new Error(`当前运行任务属于项目 ${state.project_id}，不能用项目 ${options.projectId} 继续执行`);
      }
      if (!state) state = this.initializeTask(normalized, options.taskId, options.sessionId, options.projectId);
      this.provider.setProjectId?.(options.projectId ?? state.project_id);

      if (isPause(normalized)) return this.pause(state, options);
      if (state.current_state === "EXECUTION_BLOCKED") return await this.retryBlocked(state, normalized, options);
      if (state.current_state === "TASK_PAUSED") return await this.resume(state, normalized, options);
      if (isCancelTask(normalized) && state.current_state !== "WAITING_REPLAN_CONFIRM") {
        return this.cancelTask(state, options);
      }

      if (WAITING_STATES.has(state.current_state)) {
        return await this.handleWaitingState(state, normalized, options);
      }

      const intent = routeIntent(normalized, Boolean(options.materialPath ?? extractExistingPath(normalized)));
      if (intent === "CONTINUE") return await this.continueCurrent(state, options);
      if (intent === "UNKNOWN") return this.requestIntentClarification(state, normalized, options);
      return await this.startIntent(state, intent, normalized, options);
    } catch (error) {
      return this.blockExecution(error instanceof Error ? error.message : String(error), options);
    }
  }

  private initializeTask(message: string, taskId?: string, sessionId?: string, projectId?: string, replaceTerminal = false): TaskState {
    return createTask({
      taskId: taskId ?? `agent-${Date.now()}`,
      sessionId,
      projectId: projectId ?? "default-project",
      goal: message,
      replaceTerminal,
    });
  }

  private async startIntent(
    state: TaskState,
    intent: Exclude<AgentIntent, "CONTINUE" | "UNKNOWN">,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    state = this.moveToRouting(state);
    if (intent === "CONTEXT") return await this.startContext(state, message, options);
    if (intent === "CONTEXT_REVOKE") return await this.startContextRevoke(state, message, options);
    if (intent === "PRD") return await this.startPrd(state, message, options);
    return await this.startChange(state, message, options);
  }

  private moveToRouting(state: TaskState): TaskState {
    if (state.current_state === "INITIALIZING") {
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "开始处理用户自然语言请求" });
    } else if (["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(state.current_state)) {
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "用户发起新任务" });
    }
    return requireState(state.task_id);
  }

  private async startContext(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (state.current_state !== "INTENT_ROUTING") {
      throw new Error(`当前状态 ${state.current_state} 不能启动材料整理`);
    }
    updateTask({ taskId: state.task_id, mode: "CONTEXT", goal: message });
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "用户要求整理材料和维护 Context" });

    return await this.runContextAnalysis(requireState(state.task_id), message, options);
  }

  private async runContextAnalysis(
    state: TaskState,
    message: string,
    options: HandleMessageOptions,
    allowDuplicate = false,
    structuredMaterialRefOverride?: string,
  ): Promise<AgentResponse> {

    const materialPath = options.materialPath ?? extractExistingPath(message);
    const assets = await this.provider.getContextAssets(materialPath, state.task_id, message);
    const reportRefs = this.provider.getContextReportRefs(state.task_id, assets.structuredMaterialPath);
    const registered = registerMaterials(assets.inputPath, PROJECT_ROOT, state.project_id, state.task_id);
    if (!allowDuplicate && registered.duplicate_records.length) {
      const confirmation = createConfirmation({
        taskId: state.task_id,
        type: "MATERIAL_REPROCESS",
        state: "WAITING_MATERIAL_REPROCESS_CONFIRM",
        sourceState: "CONTEXT_ANALYZING",
        title: "确认是否重新整理已存在的材料",
        actions: ["APPROVE_REPROCESS", "KEEP_EXISTING"],
        items: registered.duplicate_records.map((duplicate) => ({
          proposal_id: `material-${duplicate.source_id}`,
          source_id: duplicate.source_id,
          existing_task_id: duplicate.existing_task_id,
          existing_draft_ref: duplicate.existing_draft_ref,
          existing_structured_material_ref: duplicate.existing_structured_material_ref ?? null,
          action: "REPROCESS_MATERIAL",
          requires_confirmation: true,
        })),
      });
      assertTransition({ taskId: state.task_id, toState: "WAITING_MATERIAL_REPROCESS_CONFIRM", reason: "检测到项目中已登记相同材料" });
      return this.response({
        message: `检测到 ${registered.duplicate_records.length} 份材料已经在当前项目中整理过。是否重新整理并覆盖原整理稿？稳定 Context 不会因此自动覆盖。`,
        status: "WAITING_CONFIRMATION",
        skill: "material-ingest",
        artifacts: [
          { ref: registered.manifest_ref, label: "材料登记清单" },
          ...registered.duplicate_records.flatMap((item) => item.existing_structured_material_ref ? [{ ref: item.existing_structured_material_ref, label: "已有整理稿" }] : []),
        ],
        confirmation,
        nextSteps: ["回复“确认重新整理并覆盖”", "回复“保留已有整理稿”", "回复“暂停”"],
        debug: options.debug,
      });
    }
    const effectiveReportRefs = structuredMaterialRefOverride
      ? { ...reportRefs, structuredMaterialRef: structuredMaterialRefOverride }
      : reportRefs;
    const recorded = recordContextAnalysis({
      taskId: state.task_id,
      materialInputPath: assets.inputPath,
      materialOutputPath: assets.materialOutputPath,
      contextOutputPath: assets.contextOutputPath,
      structuredMaterialPath: assets.structuredMaterialPath,
      materialReportRef: reportRefs.materialReportRef,
      contextReportRef: reportRefs.contextReportRef,
      structuredMaterialRef: effectiveReportRefs.structuredMaterialRef,
    });
    updateMaterialIngestionArtifact(
      state.project_id,
      state.task_id,
      effectiveReportRefs.structuredMaterialRef,
      PROJECT_ROOT,
    );
    const analysis = readJson<ContextAnalysisOutput>(assets.contextOutputPath);
    const confirmableProposals = analysis.update_proposals
      .filter((proposal) => proposal.requires_confirmation)
      .filter((proposal) => !isProposalAlreadyApplied(proposal, PROJECT_ROOT))
      .filter((proposal) => !wasProposalDeferred(state.task_id, proposal) || /(确认|批准|同意|更新|提升)/.test(message));
    if (confirmableProposals.length === 0) {
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_MAINTAINING", reason: "本次仅产生可逆整理结果，无稳定 Context 写入" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_TASK_COMPLETED", reason: "通用材料整理完成" });
      return this.response({
        message: [
          `我已登记并完成 ${recorded.material_count} 份材料的结构化整理。`,
          "当前没有可以直接提升为稳定 Context 的内容。原文、分类结果和待确认问题已保留在工作区。",
          `整理稿已写入 ${effectiveReportRefs.structuredMaterialRef}。`,
          analysis.remaining_questions.length ? `发现 ${analysis.remaining_questions.length} 个需要产品经理判断的问题，未被当成既定需求。` : "没有遗留问题。",
        ].join("\n"),
        status: "COMPLETED",
        skill: "material-ingest → context-maintain",
        artifacts: [
          { ref: registered.manifest_ref, label: "材料登记清单" },
          { ref: recorded.material_report_ref, label: "材料分析报告" },
          { ref: recorded.context_report_ref, label: "Context 分析报告" },
          ...(recorded.structured_material_ref ? [{ ref: recorded.structured_material_ref, label: "结构化整理稿" }] : []),
        ],
        nextSteps: ["如需准备 PRD，请明确说明目标和范围", "也可以继续补充材料"],
        debug: options.debug,
      });
    }
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "CONTEXT_UPDATE",
      state: "WAITING_CONTEXT_CONFIRM",
      sourceState: "CONTEXT_ANALYZING",
      title: "确认稳定 Context 更新建议",
      actions: ["APPROVE_ALL", "APPROVE_SELECTED", "DEFER_ALL", "REJECT_ALL"],
      items: confirmableProposals.map((proposal) => ({ ...proposal })),
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_CONTEXT_CONFIRM", reason: "稳定 Context 变更需要 CP-C01 人工确认" });

    return this.response({
        message: [
        `我已登记并完成 ${recorded.material_count} 份材料的结构化整理。`,
        `整理稿已写入 ${effectiveReportRefs.structuredMaterialRef}。`,
        `发现 ${analysis.conflicts.length} 个冲突，形成 ${analysis.update_proposals.length} 条处理建议，其中 ${confirmation.items.length} 条会修改稳定 Context，需要你判断。`,
        analysis.remaining_questions.length
          ? `另有 ${analysis.remaining_questions.length} 个问题保留在工作区，不会被当成已确认事实。`
          : "没有遗留问题。",
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "material-ingest → context-maintain",
      artifacts: [
        { ref: registered.manifest_ref, label: "材料登记清单" },
        { ref: recorded.material_report_ref, label: "材料分析报告" },
        { ref: recorded.context_report_ref, label: "Context 分析报告" },
        ...(recorded.structured_material_ref ? [{ ref: recorded.structured_material_ref, label: "结构化整理稿" }] : []),
      ],
      confirmation,
      nextSteps: ["回复“确认全部”", "回复“只确认 proposal-id-1，其他暂不更新”", "回复“暂不更新稳定 Context”"],
      debug: options.debug,
    });
  }

  private async startContextRevoke(
    state: TaskState,
    message: string,
    options: HandleMessageOptions,
  ): Promise<AgentResponse> {
    if (state.current_state !== "INTENT_ROUTING") {
      throw new Error(`当前状态 ${state.current_state} 不能启动 Context 撤销`);
    }
    updateTask({ taskId: state.task_id, mode: "CONTEXT", goal: message });
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "分析用户请求的稳定 Context 变更" });
    const targets = findContextTargets(state.project_id, message);
    if (!targets.length) throw new Error("没有识别出要修改或撤销的稳定 Context 文件，请提供文件名、item_id 或 proposal_id");
    const sectionMove = isSectionMoveToWorkspace(message);
    const sectionMoves = sectionMove
      ? targets.flatMap((target) => buildSectionMove(state, target, message))
      : [];
    if (sectionMove && !sectionMoves.length) {
      throw new Error("已识别到局部移出请求，但没有定位到要移出的 Markdown 章节。请提供章节标题，例如“## 待确认事项”");
    }
    const proposals = sectionMove
      ? sectionMoves.map((item) => item.proposal)
      : targets.map((target) => buildArchiveProposal(state, target));
    const reportRef = this.provider.getContextReportRefs(state.task_id).contextReportRef;
    writeJsonAtomic(repoRefToPath(reportRef, PROJECT_ROOT), {
      action: "ANALYZE", update_proposals: proposals, conflicts: [], stale_items: [],
      index_issues: [], auto_actions: [],
      remaining_questions: sectionMoves.map((item) => ({
        question: `已从稳定 Context 候选中移出：${item.sectionTitles.join("、")}`,
        workspace_ref: item.workspaceRef,
        source_refs: item.proposal.source_refs,
      })),
    });
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "CONTEXT_UPDATE",
      state: "WAITING_CONTEXT_CONFIRM",
      sourceState: "CONTEXT_ANALYZING",
      title: sectionMove ? "确认稳定 Context 局部更新" : "确认撤销稳定 Context（归档，不删除原文件）",
      actions: ["APPROVE_ALL", "APPROVE_SELECTED", "DEFER_ALL", "REJECT_ALL"],
      items: proposals.map((proposal) => ({ ...proposal })),
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_CONTEXT_CONFIRM", reason: "稳定 Context 变更需要 CP-C01 人工确认" });
    return this.response({
      message: sectionMove
        ? `已生成 ${proposals.length} 条稳定 Context 局部更新建议。批准后只移出指定章节，其余内容和文件索引保持有效。`
        : `已找到 ${proposals.length} 条待撤销的稳定 Context。批准后将归档文件并从 INDEX 隐藏，不会直接删除业务文件。`,
      status: "WAITING_CONFIRMATION",
      skill: "context-maintain/ANALYZE",
      artifacts: [
        { ref: reportRef, label: sectionMove ? "Context 局部更新分析" : "Context 撤销分析" },
        ...sectionMoves.map((item) => ({ ref: item.workspaceRef, label: "移出的待确认内容" })),
        ...sectionMoves.map((item) => ({ ref: item.candidateRef, label: "稳定 Context 更新候选" })),
      ],
      confirmation,
      nextSteps: sectionMove
        ? ["回复“确认更新 proposal-id”", "回复“暂不更新稳定 Context”", "回复“暂停”"]
        : ["回复“确认撤销 proposal-id”", "回复“暂不更新稳定 Context”", "回复“暂停”"],
      debug: options.debug,
    });
  }

  private async startPrd(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (state.current_state === "INTENT_ROUTING") {
      updateTask({ taskId: state.task_id, mode: "PRD", goal: message });
      assertTransition({ taskId: state.task_id, toState: "PRD_THINKING", reason: "用户要求准备 PRD" });
    } else if (state.current_state === "CONTEXT_TASK_COMPLETED") {
      updateTask({ taskId: state.task_id, mode: "PRD", goal: message });
      assertTransition({ taskId: state.task_id, toState: "PRD_THINKING", reason: "Context 整理完成后继续 PRD" });
    } else {
      throw new Error(`当前状态 ${state.current_state} 不能启动 PRD 写前对齐`);
    }

    const assets = await this.provider.getPrdAssets(state.task_id, "THINKING");
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    const recorded = recordPrdThinking(
      state.task_id,
      assets.thinkingPath,
      PROJECT_ROOT,
      reportRefs.thinkingRef
    );
    const thinking = readJson<PrdThinkingOutput>(assets.thinkingPath);
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "DECISION_AND_WRITABLE_STATUS",
      state: "WAITING_DECISION_CONFIRM",
      sourceState: "PRD_THINKING",
      title: "确认关键决策并授权生成 PRD 主体",
      actions: ["CONFIRM_WRITABLE"],
      items: [assets.p01],
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_DECISION_CONFIRM", reason: "写前关键决策需要 CP-P01 确认" });
    return this.response({
      message: [
        "我已完成 PRD 写前对齐，还没有生成 PRD。",
        `当前有 ${thinking.writable_assessment.blockers.length} 个阻塞决策：${describePrdBlockers(thinking)}。`,
        describePrdQuestions(thinking),
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "prd-thinking",
      artifacts: [{ ref: recorded.report_ref, label: "PRD 写前分析" }],
      confirmation,
      nextSteps: ["回复“按建议确认，可以生成 PRD”", "回复“暂停”保留当前任务"],
      debug: options.debug,
    });
  }

  private async startChange(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (state.current_state !== "INTENT_ROUTING") {
      throw new Error(`当前状态 ${state.current_state} 不能启动变更分析`);
    }
    updateTask({ taskId: state.task_id, mode: "CHANGE", goal: message });
    assertTransition({ taskId: state.task_id, toState: "CHANGE_ANALYZING", reason: "用户提出已交付需求的实质变更" });
    let current = requireState(state.task_id);
    const analysisAssets = await this.provider.prepareChangeAnalysis(current, message);
    const snapshot = createTaskChangeSnapshot(state.task_id, analysisAssets.inputPath);
    const analysisResult = recordChangeAnalysis(
      state.task_id,
      analysisAssets.inputPath,
      analysisAssets.analysisPath,
      PROJECT_ROOT,
      analysisAssets.reportRef
    );
    assertTransition({ taskId: state.task_id, toState: "REPLANNING", reason: "变更影响范围已分析" });
    current = requireState(state.task_id);
    const replanAssets = await this.provider.prepareChangeReplan(current, analysisAssets);
    const replanResult = recordReplan(
      state.task_id,
      replanAssets.replanPath,
      PROJECT_ROOT,
      replanAssets.planRef
    );
    const analysis = readJson<ChangeAnalysisOutput>(analysisAssets.analysisPath);
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "REPLAN_APPROVAL",
      state: "WAITING_REPLAN_CONFIRM",
      sourceState: "REPLANNING",
      returnState: "PRD_DRAFTING_DETAILS",
      title: "确认最小重规划方案",
      actions: ["APPROVE_REPLAN", "REVISE_REPLAN", "CANCEL_CHANGE"],
      items: [replanAssets.approval],
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_REPLAN_CONFIRM", reason: "重规划方案需要 CP-R01 人工批准" });
    return this.response({
      message: [
        `我已为本次变更创建包含 ${snapshot.artifact_count} 个产物的不可变快照。`,
        `影响分析判断变更类型为 ${analysis.change_classification.change_type}，涉及 ${analysis.affected_items.length} 个产物，建议返回 ${analysis.recommended_return_state ?? "人工判断节点"}。`,
        analysis.open_questions.length ? `仍需确认：${analysis.open_questions.join("；")}。` : "当前没有新增待确认问题。",
        "批准前不会改写 PRD 或稳定 Context。",
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "change-impact/ANALYZE → change-impact/REPLAN",
      artifacts: [
        { ref: snapshot.snapshot_ref, label: "变更前快照" },
        { ref: analysisResult.report_ref, label: "变更影响报告" },
        { ref: replanResult.plan_ref, label: "重规划方案" },
      ],
      confirmation,
      nextSteps: ["回复“批准重规划”", "回复“修改重规划方案”", "回复“取消本次变更”"],
      debug: options.debug,
    });
  }

  private async handleWaitingState(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    const confirmation = getActiveConfirmation(state.task_id, state.current_state);
    if (!confirmation) throw new Error(`等待状态 ${state.current_state} 缺少待确认记录`);
    if (state.current_state === "WAITING_INTENT_CLARIFICATION") {
      const clarifiedIntent = routeIntent(message, Boolean(options.materialPath ?? extractExistingPath(message)));
      if (["UNKNOWN", "CONTINUE"].includes(clarifiedIntent)) {
        return this.confirmationReminder(confirmation, options);
      }
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "CONFIRM" });
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "用户补充了任务意图" });
      return await this.handleMessage(message, { ...options, taskId: state.task_id });
    }
    if (state.current_state === "WAITING_MATERIAL_REPROCESS_CONFIRM") {
      return await this.resolveMaterialReprocess(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_CONTEXT_CONFIRM") {
      return this.resolveContextConfirmation(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_DECISION_CONFIRM") {
      return await this.resolveP01(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_SCOPE_CONFIRM") {
      return await this.resolveP02(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_REVIEW_DECISION") {
      return await this.resolveP03(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_REPLAN_CONFIRM") {
      return this.resolveReplan(state, confirmation, message, options);
    }
    return this.confirmationReminder(confirmation, options);
  }

  private resolveContextConfirmation(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    const reportRefs = this.provider.getContextReportRefs(state.task_id);
    const analysisPath = repoRefToPath(reportRefs.contextReportRef, PROJECT_ROOT);
    const selected = selectContextProposalIds(confirmation, message);
    const isRevoke = confirmation.items.some((item) => item.action === "ARCHIVE");
    const workspaceRefs = confirmation.items
      .map((item) => item.workspace_ref)
      .filter((ref): ref is string => typeof ref === "string");
    const isSectionMove = confirmation.items.some((item) => item.action === "UPDATE_CONTEXT" && typeof item.workspace_ref === "string");
    if (selected.mode === "DEFER" || selected.mode === "REJECT") {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: selected.mode === "REJECT" ? "REJECT_ALL" : "DEFER_ALL" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "用户暂不更新稳定 Context" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_MAINTAINING", reason: "仅保留可逆分析产物" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_TASK_COMPLETED", reason: "材料整理完成，稳定 Context 未变更" });
      return this.response({
        message: isRevoke
          ? "已保留原稳定 Context 文件，本次没有执行撤销。"
          : isSectionMove
            ? "已保留原稳定 Context 不变；局部更新候选和移出内容仍保存在 workspace，未提升为稳定事实。"
            : `材料、分析报告和整理稿已保留在 drafts/workspace；整理稿位置为 ${reportRefs.structuredMaterialRef}。按你的决定，本次没有更新稳定 Context。`,
        status: "COMPLETED",
        skill: "context-maintain",
        artifacts: [
          { ref: reportRefs.contextReportRef, label: "Context 分析报告" },
          ...workspaceRefs.map((ref) => ({ ref, label: "移出的待确认内容" })),
          ...(!isRevoke && !isSectionMove ? [{ ref: reportRefs.structuredMaterialRef, label: "结构化整理稿" }] : []),
        ],
        nextSteps: ["之后可说“继续准备 PRD”", "也可以补充新材料后重新分析"],
        debug: options.debug,
      });
    }
    resolveConfirmation({
      taskId: state.task_id,
      confirmationId: confirmation.confirmation_id,
      resolution: selected.ids.length === confirmation.items.length ? "APPROVE_ALL" : "APPROVE_SELECTED",
      selectedIds: selected.ids,
      rejectedIds: selected.rejectedIds,
    });
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_MAINTAINING", reason: "执行用户批准的稳定 Context 更新" });
    const result = applyContextActions(
      state.task_id,
      analysisPath,
      PROJECT_ROOT,
      reportRefs.changeLogRef
    );
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_TASK_COMPLETED", reason: "Context 维护任务完成" });
    return this.response({
      message: [
        `已按你的决定处理 ${result.executed_actions.length + result.skipped_actions.length} 条稳定 Context 建议。`,
        ...(isRevoke || isSectionMove ? [] : [`整理稿位置为 ${reportRefs.structuredMaterialRef}。`]),
        result.executed_actions.length
          ? `${isRevoke ? "已归档" : isSectionMove ? "已局部更新" : "已更新"}：${result.executed_actions.join("、")}。`
          : "候选内容与现有稳定 Context 一致，因此保持幂等，没有重复创建版本。",
        `仍有 ${result.health_check.remaining_issues.length} 个问题保留为待确认事项。`,
      ].join("\n"),
      status: "COMPLETED",
      skill: "context-maintain/APPLY",
      artifacts: [
        { ref: result.change_log_ref, label: isRevoke ? "Context 撤销记录" : "Context 变更记录" },
        { ref: contextIndexRef(state.project_id), label: "稳定 Context 索引" },
        ...workspaceRefs.map((ref) => ({ ref, label: "移出的待确认内容" })),
        ...(!isRevoke && !isSectionMove ? [{ ref: reportRefs.structuredMaterialRef, label: "结构化整理稿" }] : []),
      ],
      nextSteps: ["回复“继续准备 PRD”进入写前对齐", "回复新的材料整理任务"],
      debug: options.debug,
    });
  }

  private async resolveMaterialReprocess(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions,
  ): Promise<AgentResponse> {
    if (/(保留|不重新|不覆盖|取消|拒绝|否)/.test(message) && !/(重新整理|覆盖)/.test(message)) {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "KEEP_EXISTING" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_MAINTAINING", reason: "用户选择保留已有整理稿" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_TASK_COMPLETED", reason: "重复材料未重新整理" });
      return this.response({
        message: "检测到材料已经整理过，本次保留已有整理稿，没有重新分析或覆盖。",
        status: "COMPLETED",
        skill: "material-ingest",
        artifacts: confirmation.items.flatMap((item) => typeof item.existing_structured_material_ref === "string" ? [{ ref: item.existing_structured_material_ref, label: "已有整理稿" }] : []),
        nextSteps: ["如需重新整理，请重新提交同一材料并明确确认覆盖", "也可以补充新材料后重新分析"],
        debug: options.debug,
      });
    }
    if (!/(重新整理|覆盖|重做|确认)/.test(message)) return this.confirmationReminder(confirmation, options);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "APPROVE_REPROCESS" });
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "用户确认重新整理并覆盖已有整理稿" });
    const targetRef = confirmation.items.find((item) => typeof item.existing_structured_material_ref === "string")?.existing_structured_material_ref;
    return await this.runContextAnalysis(requireState(state.task_id), state.task_goal, options, true, typeof targetRef === "string" ? targetRef : undefined);
  }

  private async resolveP01(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (!/(确认|同意|按建议|可以生成|继续)/.test(message)) return this.confirmationReminder(confirmation, options);
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "CONFIRM_WRITABLE" });
    assertTransition({ taskId: state.task_id, toState: "PRD_DRAFTING_CORE", reason: "CP-P01 已确认可写" });
    const assets = await this.provider.getPrdAssets(state.task_id, "CORE", { userConfirmation: message });
    recordConfirmedDecisions(
      state.task_id,
      assets.confirmedLedgerPath,
      PROJECT_ROOT,
      reportRefs.ledgerRef
    );
    const coreResult = applyPrdArtifact(state.task_id, assets.corePath);
    const core = readJson<PrdWriteOutput>(assets.corePath);
    const p02 = createConfirmation({
      taskId: state.task_id,
      type: "SCOPE_AND_CORE_FLOW",
      state: "WAITING_SCOPE_CONFIRM",
      sourceState: "PRD_DRAFTING_CORE",
      title: "确认 PRD 范围与核心流程",
      actions: ["APPROVE_CORE"],
      items: [assets.p02],
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_SCOPE_CONFIRM", reason: "PRD 主体完成，需要 CP-P02 确认" });
    return this.response({
      message: [
        `关键决策已写入决策账本，PRD 主体 ${coreResult.version} 已生成。`,
        "主体只包含背景、目标、范围、核心流程和已确认决策，尚未展开权限、异常与验收细节。",
        `请确认范围与核心流程后，再继续生成 DETAILS。当前还有 ${core.unresolved_items.length} 个非阻塞待办。`,
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "prd-write/CORE",
      artifacts: [
        { ref: reportRefs.ledgerRef, label: "已确认决策账本" },
        { ref: coreResult.artifact_ref, label: "PRD 主体" },
      ],
      confirmation: p02,
      nextSteps: ["回复“确认范围和核心流程”", "回复“暂停”保留当前版本"],
      debug: options.debug,
    });
  }

  private async resolveP02(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (!/(确认|同意|批准|继续)/.test(message)) return this.confirmationReminder(confirmation, options);
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "APPROVE_CORE" });
    assertTransition({ taskId: state.task_id, toState: "PRD_DRAFTING_DETAILS", reason: "CP-P02 已确认范围和核心流程" });
    const assets = await this.provider.getPrdAssets(state.task_id, "DETAILS", { userConfirmation: message });
    const detailsResult = applyPrdArtifact(state.task_id, assets.detailsPath);
    assertTransition({ taskId: state.task_id, toState: "PRD_REVIEWING", reason: "PRD 细节已补充" });
    const reviewResult = recordPrdReview(
      state.task_id,
      assets.reviewTemplatePath,
      assets.prdRef,
      PROJECT_ROOT,
      reportRefs.reviewRef
    );
    const p03 = createConfirmation({
      taskId: state.task_id,
      type: "REVIEW_DISPOSITION",
      state: "WAITING_REVIEW_DECISION",
      sourceState: "PRD_REVIEWING",
      title: "处理独立审核结果并决定是否交付",
      actions: ["ACCEPT_AND_DELIVER", "FIX_AND_REVIEW"],
      items: [assets.p03],
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_REVIEW_DECISION", reason: "独立审核完成，需要 CP-P03 处理决定" });
    return this.response({
      message: [
        `PRD 已补充到 ${detailsResult.version}，并完成独立审核。`,
        `审核结果：P0=${reviewResult.summary.p0_count}，P1=${reviewResult.summary.p1_count}，P2=${reviewResult.summary.p2_count}，建议 ${reviewResult.summary.recommendation}。`,
        reviewDispositionHint(reviewResult),
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "prd-write/DETAILS → prd-review",
      artifacts: [
        { ref: detailsResult.artifact_ref, label: "完整 PRD" },
        { ref: reviewResult.review_ref, label: "PRD 独立审核报告" },
      ],
      confirmation: p03,
      nextSteps: ["回复“接受 P2 并交付”", "回复“先修复再审核”"],
      debug: options.debug,
    });
  }

  private async resolveP03(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): Promise<AgentResponse> {
    if (/(修复|修改|先改)/.test(message)) {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "FIX_AND_REVIEW" });
      assertTransition({ taskId: state.task_id, toState: "PRD_REVIEWING", reason: "用户要求先修复审核问题" });
      return this.response({
        message: "已记录“先修复再审核”。我不会替你决定审核问题的业务修订内容，任务停在重新审核节点。",
        status: "CONTINUE",
        skill: "prd-review",
        artifacts: [],
        nextSteps: ["补充具体修订决定后继续", "也可说“暂停”"],
        debug: options.debug,
      });
    }
    if (!/(接受|交付|确认|同意)/.test(message)) return this.confirmationReminder(confirmation, options);
    const assets = await this.provider.getPrdAssets(state.task_id, "REFERENCE");
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "ACCEPT_AND_DELIVER" });
    const reviewPath = repoRefToPath(reportRefs.reviewRef, PROJECT_ROOT);
    const delivered = finalizePrdDelivery(state.task_id, assets.prdRef, reviewPath);
    assertTransition({ taskId: state.task_id, toState: "DELIVERED", reason: "CP-P03 已接受审核结果并交付" });
    return this.response({
      message: `PRD ${delivered.version} 已完成交付。材料来源、已确认决策、PRD 正文和独立审核报告均已落盘并可追溯。`,
      status: "COMPLETED",
      skill: "PRD delivery",
      artifacts: [
        { ref: delivered.prd_ref, label: "已交付 PRD" },
        { ref: reportRefs.reviewRef, label: "独立审核报告" },
        { ref: reportRefs.ledgerRef, label: "决策账本" },
      ],
      nextSteps: ["可直接用自然语言提出后续变更", "也可以开始新的材料整理任务"],
      debug: options.debug,
    });
  }

  private resolveReplan(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (/(取消|放弃|不改)/.test(message)) {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "CANCEL_CHANGE" });
      const restored = restoreCancelledChange(state.task_id);
      const target = requireState(state.task_id).return_state;
      if (!target) throw new Error("取消变更后缺少返回节点");
      assertTransition({ taskId: state.task_id, toState: target, reason: "取消变更并恢复快照" });
      return this.response({
        message: `已取消本次变更并恢复 ${restored.restored_refs.length} 个产物，任务返回变更前状态。`,
        status: "COMPLETED",
        skill: "change-impact/CANCEL",
        artifacts: [{ ref: restored.report_ref, label: "变更恢复记录" }],
        nextSteps: ["可重新提出更明确的变更", "也可以开始新任务"],
        debug: options.debug,
      });
    }
    if (/(修改|调整|重做)/.test(message)) {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "REVISE_REPLAN" });
      assertTransition({ taskId: state.task_id, toState: "REPLANNING", reason: "用户要求修改重规划方案" });
      return this.response({
        message: "已记录修改重规划方案的决定。请补充希望调整的返回节点、保留项或执行顺序。",
        status: "CONTINUE",
        skill: "change-impact/REPLAN",
        artifacts: [],
        nextSteps: ["说明计划中要修改的具体内容"],
        debug: options.debug,
      });
    }
    if (!/(批准|同意|确认|继续)/.test(message)) return this.confirmationReminder(confirmation, options);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "APPROVE_REPLAN" });
    const applied = applyApprovedReplan(state.task_id);
    assertTransition({ taskId: state.task_id, toState: applied.return_state, reason: "CP-R01 已批准最小重规划方案" });
    return this.response({
      message: [
        `重规划 ${applied.plan_version} 已批准并固化。`,
        `任务已返回 ${applied.return_state}；保留项和受影响范围以已批准的重规划方案为准。`,
        "我不会在缺少新的业务修订输入时直接覆盖已交付 PRD，请补充具体修改内容后继续。",
      ].join("\n"),
      status: "CONTINUE",
      skill: "change-impact/APPLY",
      artifacts: [{ ref: applied.plan_ref, label: "已批准重规划方案" }],
      nextSteps: ["补充具体细节修订内容后继续", "也可说“暂停”保留当前节点"],
      debug: options.debug,
    });
  }

  private requestIntentClarification(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    state = this.moveToRouting(state);
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "INTENT_CLARIFICATION",
      state: "WAITING_INTENT_CLARIFICATION",
      sourceState: "INTENT_ROUTING",
      title: "确认本次任务目标",
      actions: ["CONFIRM", "CANCEL"],
      items: [{ original_message: message }],
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_INTENT_CLARIFICATION", reason: "用户意图不够明确" });
    return this.response({
      message: "我还无法判断你是想只整理材料、准备 PRD，还是修改已有需求。请补充一个明确目标。",
      status: "WAITING_CONFIRMATION",
      artifacts: [],
      confirmation,
      nextSteps: ["例如：“只整理这些材料，不写 PRD”", "例如：“基于当前 Context 准备 PRD”", "例如：“修改已交付需求中的目标失效规则”"],
      debug: options.debug,
    });
  }

  private async continueCurrent(state: TaskState, options: HandleMessageOptions): Promise<AgentResponse> {
    if (state.current_state === "CONTEXT_TASK_COMPLETED") {
      return await this.startPrd(state, "基于已整理的 Context 继续准备 PRD", options);
    }
    return this.response({
      message: `当前任务位于“${stateName(state.current_state)}”，请给出该节点需要的具体输入。`,
      status: "CONTINUE",
      artifacts: state.latest_output_ref ? [{ ref: state.latest_output_ref, label: "最近产物" }] : [],
      nextSteps: ["查看当前提示并补充材料、决策或修改内容"],
      debug: options.debug,
    });
  }

  private pause(state: TaskState, options: HandleMessageOptions): AgentResponse {
    if (["TASK_PAUSED", "TASK_CANCELLED", "DELIVERED", "CONTEXT_TASK_COMPLETED"].includes(state.current_state)) {
      return this.response({ message: "当前任务无需再次暂停。", status: "COMPLETED", artifacts: [], nextSteps: [], debug: options.debug });
    }
    assertTransition({ taskId: state.task_id, toState: "TASK_PAUSED", reason: "用户暂停任务", operator: "USER" });
    return this.response({
      message: "任务已暂停，状态、确认记录和已生成产物都已保留。",
      status: "COMPLETED",
      artifacts: state.latest_output_ref ? [{ ref: state.latest_output_ref, label: "最近产物" }] : [],
      nextSteps: ["回复“继续”恢复到暂停前节点"],
      debug: options.debug,
    });
  }

  private async resume(state: TaskState, message: string, options: HandleMessageOptions): Promise<AgentResponse> {
    if (!/(继续|恢复)/.test(message)) {
      return this.response({
        message: "任务当前已暂停。回复“继续”可以恢复，回复“取消任务”可以结束。",
        status: "CONTINUE",
        artifacts: [],
        nextSteps: ["继续", "取消任务"],
        debug: options.debug,
      });
    }
    if (!state.previous_state) throw new Error("暂停任务缺少可恢复状态");
    assertTransition({ taskId: state.task_id, toState: state.previous_state, reason: "用户恢复暂停任务", operator: "USER" });
    const resumed = requireState(state.task_id);
    if (WAITING_STATES.has(resumed.current_state)) {
      const confirmation = getActiveConfirmation(resumed.task_id, resumed.current_state);
      if (confirmation) return this.confirmationReminder(confirmation, options);
    }
    return await this.continueCurrent(resumed, options);
  }

  private cancelTask(state: TaskState, options: HandleMessageOptions): AgentResponse {
    assertTransition({ taskId: state.task_id, toState: "TASK_CANCELLED", reason: "用户取消任务", operator: "USER" });
    return this.response({
      message: "任务已取消。已生成的文件和事件记录会保留，但不会继续执行后续写入。",
      status: "COMPLETED",
      artifacts: state.latest_output_ref ? [{ ref: state.latest_output_ref, label: "最近产物" }] : [],
      nextSteps: ["输入新的明确目标可开始新任务"],
      debug: options.debug,
    });
  }

  private async retryBlocked(state: TaskState, message: string, options: HandleMessageOptions): Promise<AgentResponse> {
    if (!/(重试|继续|恢复)/.test(message)) {
      return this.response({
        message: `任务因错误停止：${state.error_info ?? "未记录错误原因"}。修正配置或输入后回复“重试”，也可以暂停或取消任务。`,
        status: "BLOCKED",
        artifacts: state.latest_output_ref ? [{ ref: state.latest_output_ref, label: "最近有效产物" }] : [],
        nextSteps: ["重试", "暂停", "取消任务"],
        debug: options.debug,
      });
    }
    if (!state.previous_state) throw new Error("阻塞任务缺少可恢复状态");
    assertTransition({ taskId: state.task_id, toState: state.previous_state, reason: "用户修正阻塞原因后重试", operator: "USER" });
    const resumed = requireState(state.task_id);
    resumed.error_info = null;
    resumed.retry_count += 1;
    writeTaskState(resumed);
    if (WAITING_STATES.has(resumed.current_state)) {
      const confirmation = getActiveConfirmation(resumed.task_id, resumed.current_state);
      if (confirmation) return this.confirmationReminder(confirmation, options);
    }
    if (resumed.current_state === "CONTEXT_ANALYZING" && resumed.task_mode === "CONTEXT") {
      return await this.runContextAnalysis(resumed, resumed.task_goal, options);
    }
    const intent = resumed.task_mode ?? routeIntent(resumed.task_goal);
    if (resumed.current_state === "CONTEXT_TASK_COMPLETED" && intent === "PRD") {
      return await this.startPrd(resumed, resumed.task_goal, options);
    }
    if (["INTENT_ROUTING", "DELIVERED", "TASK_CANCELLED"].includes(resumed.current_state) && ["CONTEXT", "PRD", "CHANGE"].includes(intent)) {
      return await this.startIntent(resumed, intent as Exclude<AgentIntent, "CONTINUE" | "UNKNOWN">, resumed.task_goal, options);
    }
    return this.response({
      message: `已恢复到“${stateName(resumed.current_state)}”。请重新提交该节点所需的确认或业务输入。`,
      status: "CONTINUE",
      artifacts: resumed.latest_output_ref ? [{ ref: resumed.latest_output_ref, label: "最近有效产物" }] : [],
      nextSteps: ["重新提交上一条输入"],
      debug: options.debug,
    });
  }

  private blockExecution(message: string, options: HandleMessageOptions): AgentResponse {
    const state = readTaskState();
    const executionStates = new Set<StateId>([
      "INTENT_ROUTING", "CONTEXT_ANALYZING", "CONTEXT_MAINTAINING", "PRD_THINKING",
      "PRD_DRAFTING_CORE", "PRD_DRAFTING_DETAILS", "PRD_REVIEWING", "CHANGE_ANALYZING", "REPLANNING",
    ]);
    if (state && executionStates.has(state.current_state)) {
      assertTransition({ taskId: state.task_id, toState: "EXECUTION_BLOCKED", reason: message, operator: "SYSTEM" });
      const blockedState = requireState(state.task_id);
      blockedState.previous_state = state.current_state;
      blockedState.error_info = message;
      writeTaskState(blockedState);
    }
    return this.blocked(message, options);
  }

  private confirmationReminder(confirmation: ConfirmationRecord, options: HandleMessageOptions): AgentResponse {
    return this.response({
      message: `当前需要你处理“${confirmation.title}”。我没有把这句话解释为批准，因此没有继续执行。`,
      status: "WAITING_CONFIRMATION",
      artifacts: [],
      confirmation,
      nextSteps: humanActions(confirmation),
      debug: options.debug,
    });
  }

  private blocked(message: string, options: HandleMessageOptions): AgentResponse {
    return this.response({
      message: `执行已停止：${message}`,
      status: "BLOCKED",
      artifacts: [],
      nextSteps: ["修正输入后重新发送", "可回复“暂停”保留当前任务"],
      debug: options.debug,
    });
  }

  private response(input: {
    message: string;
    status: AgentResponse["status"];
    skill?: string;
    artifacts: AgentArtifact[];
    confirmation?: ConfirmationRecord;
    nextSteps: string[];
    debug?: boolean;
  }): AgentResponse {
    const state = readTaskState();
    const stateId = state?.current_state ?? "INITIALIZING";
    const definition = loadStates().find((item) => item.id === stateId);
    return {
      message: input.message,
      state: {
        id: stateId,
        name: definition?.name ?? "初始化",
        type: definition?.type ?? "entry",
      },
      status: input.status,
      execution_authority: "RUNTIME_ONLY",
      execution_status: executionStatus(input.status, stateId),
      result_is_authoritative: true,
      external_agent_instruction: instructionFor(input.status, stateId),
      provider: { id: this.provider.id, label: this.provider.label },
      skill: input.skill,
      artifacts: input.artifacts,
      confirmation: input.confirmation ? {
        id: input.confirmation.confirmation_id,
        title: input.confirmation.title,
        actions: input.confirmation.allowed_actions,
        items: input.confirmation.items,
      } : undefined,
      next_steps: input.nextSteps,
      debug: input.debug && state ? { task_id: state.task_id, state_id: state.current_state } : undefined,
    };
  }
}

function executionStatus(status: AgentResponse["status"], state: StateId): AgentResponse["execution_status"] {
  if (status === "COMPLETED" && ["CONTEXT_TASK_COMPLETED", "DELIVERED"].includes(state)) return "COMPLETED";
  if (status === "WAITING_CONFIRMATION" || state.startsWith("WAITING_")) return "WAITING_USER_CONFIRMATION";
  if (state === "TASK_CANCELLED") return "CANCELLED";
  if (status === "BLOCKED" || state === "EXECUTION_BLOCKED") return "BLOCKED";
  return "IN_PROGRESS";
}

function instructionFor(status: AgentResponse["status"], state: StateId): string {
  if (executionStatus(status, state) === "COMPLETED") return "只能展示 Runtime 返回的完成产物；不得另建替代文件。";
  if (executionStatus(status, state) === "WAITING_USER_CONFIRMATION") return "Runtime 尚未完成。只能展示确认项并等待用户，不得自行整理、写文件或宣称任务完成。";
  if (executionStatus(status, state) === "BLOCKED") return "Runtime 已停止。不得生成替代结果或写入业务文件，需先处理阻塞原因。";
  if (executionStatus(status, state) === "CANCELLED") return "任务已取消。只能保留和展示 Runtime 历史记录，不得恢复或另建替代产物。";
  return "Runtime 正在处理。不得绕过 Runtime 执行业务 Skill 或写入业务文件。";
}

export function routeIntent(message: string, hasMaterialPath = false): AgentIntent {
  if (/^(继续|恢复|下一步)$/.test(message.trim())) return "CONTINUE";
  if (/(撤销|回滚|取消提升|移(?:出|除).*(?:稳定\s*)?(?:context|contact)|从.*(?:context|contact).*移(?:出|除)|归档.*context)/i.test(message)) return "CONTEXT_REVOKE";
  if (/(只整理|整理材料|整理资料|整理.*(会议|会议记录|会议纪要|用户反馈|历史\s*prd|产品现状|业务约束)|收集整理|整理并沉淀|沉淀|维护\s*context|先不(?:要)?写\s*prd|不要写\s*prd|不生成\s*prd|资料归档|材料分析|用户反馈|确认.*(?:proposal|item-\d+)|批准.*(?:proposal|item-\d+))/i.test(message)) return "CONTEXT";
  if (/(修改|变更|改成|调整已有|不要做|增加规则|下线|删除后)/.test(message)) return "CHANGE";
  if (/(准备\s*prd|写\s*prd|生成\s*prd|需求文档|继续准备\s*prd)/i.test(message)) return "PRD";
  if (hasMaterialPath) return "CONTEXT";
  return "UNKNOWN";
}

export function selectContextProposalIds(
  confirmation: ConfirmationRecord,
  message: string
): { mode: "APPROVE" | "DEFER" | "REJECT"; ids: string[]; rejectedIds: string[] } {
  const hasPositive = /(确认|批准|同意|采纳|提升|撤销|归档)/.test(message);
  const hasNegative = /(暂不|先不|不更新|延后|忽略|拒绝|不(?:要|予以)?(?:撤销|归档))/.test(message);
  const rejectedIds = new Set<string>();
  const deferredIds = new Set<string>();
  for (const [index, item] of confirmation.items.entries()) {
    const id = item.proposal_id;
    if (typeof id !== "string") continue;
    const aliases = [id, item.item_id, item.target_ref, item.proposed_value]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(escapeRegExp);
    const aliasPattern = aliases.join("|");
    const itemPattern = `(?:${aliasPattern}|第\\s*${index + 1}\\s*(?:条|项))`;
    if (new RegExp(`拒绝[^。；;，,\\n]{0,100}${itemPattern}|${itemPattern}[^。；;，,\\n]{0,100}拒绝`).test(message)) rejectedIds.add(id);
    if (new RegExp(`(?:暂不|先不|不更新|延后|忽略)[^。；;，,\\n]{0,100}${itemPattern}|${itemPattern}[^。；;，,\\n]{0,100}(?:暂不|先不|不更新|延后|忽略)`).test(message)) deferredIds.add(id);
  }
  if (!hasPositive && hasNegative && rejectedIds.size === 0) return { mode: "DEFER", ids: [], rejectedIds: [] };
  if (!hasPositive && rejectedIds.size === confirmation.items.length) return { mode: "REJECT", ids: [], rejectedIds: [...rejectedIds] };
  if (/(全部|都确认|全确认)/.test(message)) {
    const ids = proposalIds(confirmation.items).filter((id) => !deferredIds.has(id) && !rejectedIds.has(id));
    if (ids.length) return { mode: "APPROVE", ids, rejectedIds: [...rejectedIds] };
  }
  const selected: string[] = [];
  for (const [index, item] of confirmation.items.entries()) {
    const id = item.proposal_id;
    const text = `${item.proposed_value ?? ""} ${item.target_ref ?? ""} ${item.item_id ?? ""}`;
    if (typeof id !== "string") continue;
    if (deferredIds.has(id) || rejectedIds.has(id)) continue;
    const aliases = [id, item.item_id, item.target_ref, item.proposed_value]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (aliases.some((alias) => message.includes(alias)) || new RegExp(`第\\s*${index + 1}\\s*(条|项)`).test(message)) selected.push(id);
    if (/(方案|提议|解决方案)/.test(message) && /(solution|proposal|方案|提议)/i.test(text)) selected.push(id);
    if (/(边界|范围|约束|规则)/.test(message) && /(boundary|scope|constraint|rule|边界|范围|约束|规则)/i.test(text)) selected.push(id);
  }
  if (!selected.length && confirmation.items.length === 1 && hasPositive && !hasNegative) {
    return { mode: "APPROVE", ids: proposalIds(confirmation.items), rejectedIds: [] };
  }
  if (!selected.length) throw new Error("没有识别出你批准的具体 Context 建议。请提供 proposal_id 或编号，并明确其他建议暂不更新");
  return { mode: "APPROVE", ids: [...new Set(selected)], rejectedIds: [...rejectedIds] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function proposalIds(items: ConfirmationRecord["items"]): string[] {
  return items.map((item) => item.proposal_id).filter((id): id is string => typeof id === "string");
}

function isProposalAlreadyApplied(proposal: ContextProposal, root: string): boolean {
  if (!proposal.target_ref) return false;
  try {
    const targetPath = repoRefToPath(proposal.target_ref, root);
    if (!fs.existsSync(targetPath)) return false;
    const current = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
    const candidate = proposal.content_ref && fs.existsSync(repoRefToPath(proposal.content_ref, root))
      ? parseFrontmatter(fs.readFileSync(repoRefToPath(proposal.content_ref, root), "utf-8"))
      : null;
    return current.metadata.status === "archived" || (candidate !== null && current.body.trim() === candidate.body.trim());
  } catch {
    return false;
  }
}

function wasProposalDeferred(taskId: string, proposal: ContextProposal): boolean {
  const pending = readPendingConfirmations();
  if (!pending || pending.task_id !== taskId) return false;
  return pending.records.some((record) =>
    record.confirmation_type === "CONTEXT_UPDATE" &&
    record.items.some((item) => {
      if (!["DEFERRED", "REJECTED"].includes(item.approval_status ?? "") && !["DEFERRED", "REJECTED"].includes(record.status)) return false;
      if (item.proposal_id === proposal.proposal_id) return true;
      const previousValue = item.proposed_value;
      return typeof previousValue === "string" && previousValue === proposal.proposed_value
        && JSON.stringify(item.source_refs ?? []) === JSON.stringify(proposal.source_refs);
    })
  );
}

interface ContextTarget {
  targetRef: string;
  path: string;
  document: ReturnType<typeof parseFrontmatter>;
}

interface MarkdownSection {
  title: string;
  level: number;
  start: number;
  end: number;
  content: string;
}

interface ContextSectionMove {
  proposal: ContextProposal;
  workspaceRef: string;
  candidateRef: string;
  sectionTitles: string[];
}

function findContextTargets(projectId: string, message: string): ContextTarget[] {
  const root = contextRootPath(projectId);
  if (!fs.existsSync(root)) return [];
  const matches: ContextTarget[] = [];
  const matchesAll = /(?:撤销|归档).{0,20}(?:全部|所有)(?:稳定\s*)?(?:context|文件)|(?:全部|所有)(?:稳定\s*)?(?:context|文件).{0,20}(?:撤销|归档)/i.test(message);
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const filePath = path.join(directory, name);
      if (fs.statSync(filePath).isDirectory()) walk(filePath);
      else if (name.endsWith(".md")) {
        if (name === "INDEX.md") continue;
        const document = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
        const ref = pathToRepoRef(filePath, PROJECT_ROOT);
        const itemIds = [...message.matchAll(/(?:proposal-|item-|revoke-)[a-z0-9-]+/gi)].map((match) => match[0]);
        const targetTokens = [name, path.basename(name, ".md"), ref, String(document.metadata.id ?? "")].filter(Boolean);
        const matchesExplicitTarget = targetTokens.some((token) => token && message.includes(token))
          || itemIds.some((token) => targetTokens.some((target) => target.includes(token) || token.includes(target)));
        if (document.metadata.status !== "archived" && (matchesExplicitTarget || matchesAll)) {
          matches.push({ targetRef: ref, path: filePath, document });
        }
      }
    }
  };
  walk(root);
  return matches;
}

function isSectionMoveToWorkspace(message: string): boolean {
  const hasSectionScope = /章节|一节|这部分|该部分|指定内容|以下内容|#{1,6}\s+[^\n]+/.test(message);
  return /(移出|移除|转移|转存|挪到|放到|放入)/.test(message)
    && hasSectionScope
    && !/(整个文件|整份文件|全文|全部归档)/.test(message);
}

function buildSectionMove(state: TaskState, target: ContextTarget, message: string): ContextSectionMove[] {
  const sections = parseMarkdownSections(target.document.body);
  const requested = sections.filter((section) => isRequestedMoveSection(section, message));
  if (!requested.length) return [];

  const removedLines = new Set<number>();
  for (const section of requested) {
    for (let line = section.start; line < section.end; line += 1) removedLines.add(line);
  }
  const remainingBody = target.document.body
    .split(/\r?\n/)
    .filter((_line, index) => !removedLines.has(index))
    .join("\n")
    .trim();
  if (!remainingBody) throw new Error(`局部移出会清空整个稳定 Context 文件，必须改用整文件归档: ${target.targetRef}`);

  const id = String(target.document.metadata.id ?? path.basename(target.path, ".md"));
  const version = String(target.document.metadata.version ?? "0.0.0");
  const sourceRefs = Array.isArray(target.document.metadata.source_refs) ? target.document.metadata.source_refs : [];
  if (!sourceRefs.length) throw new Error(`稳定 Context 缺少 source_refs，不能执行局部更新: ${target.targetRef}`);
  const taskSlug = safeArtifactName(state.task_id);
  const fileSlug = safeArtifactName(id);
  const candidatePath = path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", taskSlug, "candidates", `context-update-${fileSlug}.md`);
  const workspacePath = path.join(PROJECT_ROOT, "context-workspace/workspace/projects", state.project_id, "context-pending", taskSlug, `${fileSlug}.md`);
  const candidateRef = pathToRepoRef(candidatePath, PROJECT_ROOT);
  const workspaceRef = pathToRepoRef(workspacePath, PROJECT_ROOT);
  const sectionTitles = requested.map((section) => section.title);
  writeTextAtomic(candidatePath, renderFrontmatter(target.document.metadata, remainingBody));
  writeTextAtomic(workspacePath, renderFrontmatter({
    id: `pending-${fileSlug}-${taskSlug}`,
    status: "pending",
    source_ref: target.targetRef,
    base_version: version,
    section_titles: sectionTitles,
  }, [
    "# 从稳定 Context 移出的待确认内容",
    "",
    `- 原稳定文件：${target.targetRef}`,
    `- 原版本：${version}`,
    "- 当前层级：workspace（未确认内容）",
    "",
    ...requested.flatMap((section) => [section.content.trim(), ""]),
  ].join("\n")));

  return [{
    proposal: {
      proposal_id: `update-${id}-move-sections`,
      action: "UPDATE_CONTEXT",
      target_ref: target.targetRef,
      item_id: id,
      current_value: target.document.body,
      proposed_value: remainingBody,
      source_refs: sourceRefs,
      relationship: "SUPERSEDES",
      risk_level: "HIGH",
      requires_confirmation: true,
      impact_if_applied: `仅从稳定 Context 移出章节“${sectionTitles.join("、")}”，其余内容保持 active；移出内容保存在 workspace`,
      impact_if_ignored: "保持当前稳定 Context 不变，workspace 中仅保留待确认候选",
      base_version: version,
      content_ref: candidateRef,
      workspace_ref: workspaceRef,
      section_titles: sectionTitles,
    },
    workspaceRef,
    candidateRef,
    sectionTitles,
  }];
}

function parseMarkdownSections(body: string): MarkdownSection[] {
  const lines = body.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match ? [{ title: match[2].trim(), level: match[1].length, start: index }] : [];
  });
  return headings.map((heading, index) => {
    const end = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)?.start ?? lines.length;
    return { ...heading, end, content: lines.slice(heading.start, end).join("\n") };
  });
}

function isRequestedMoveSection(section: MarkdownSection, message: string): boolean {
  if (section.level === 1) return false;
  const escaped = escapeRegExp(section.title);
  const preservePattern = new RegExp(
    `(?:保留|维持|保持|继续保留)\\s*(?:#{1,6}\\s*)?${escaped}|(?:#{1,6}\\s*)?${escaped}(?:部分|章节|一节)?\\s*(?:保留|维持|保持|不变|继续有效)`
  );
  if (preservePattern.test(message)) return false;
  return message.includes(section.title) || message.includes(`${"#".repeat(section.level)} ${section.title}`);
}

function safeArtifactName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "context-item";
}

function buildArchiveProposal(state: TaskState, target: ContextTarget): ContextProposal {
  const id = String(target.document.metadata.id ?? path.basename(target.path, ".md"));
  const version = String(target.document.metadata.version ?? "0.0.0");
  return {
    proposal_id: `revoke-${id}`,
    action: "ARCHIVE",
    target_ref: target.targetRef,
    item_id: id,
    current_value: target.document.body,
    proposed_value: "归档稳定 Context 文件并从索引隐藏",
    source_refs: Array.isArray(target.document.metadata.source_refs) ? target.document.metadata.source_refs : [],
    relationship: "SUPERSEDES",
    risk_level: "HIGH",
    requires_confirmation: true,
    impact_if_applied: "文件保留但标记为 archived，后续 Context 索引不再展示",
    impact_if_ignored: "保持当前稳定 Context 不变",
    base_version: version,
    content_ref: target.targetRef,
  };
}

function humanActions(confirmation: ConfirmationRecord): string[] {
  const type = confirmation.confirmation_type;
  if (type === "CONTEXT_UPDATE") return ["确认全部", "按编号确认指定建议", "暂不更新稳定 Context"];
  if (type === "DECISION_AND_WRITABLE_STATUS") return ["按建议确认，可以生成 PRD"];
  if (type === "SCOPE_AND_CORE_FLOW") return ["确认范围和核心流程"];
  if (type === "REVIEW_DISPOSITION") return ["接受 P2 并交付", "先修复再审核"];
  if (type === "REPLAN_APPROVAL") return ["批准重规划", "修改重规划方案", "取消本次变更"];
  return ["补充明确的任务目标"];
}

function describePrdBlockers(thinking: PrdThinkingOutput): string {
  const questions = thinking.writable_assessment.priority_questions;
  const labels = questions
    .map((item) => item && typeof item === "object" && "question" in item ? String(item.question) : "")
    .filter(Boolean);
  return labels.length ? labels.join("、") : "关键目标、范围或决策";
}

function describePrdQuestions(thinking: PrdThinkingOutput): string {
  const questions = thinking.writable_assessment.priority_questions;
  if (!questions.length) return "没有新增优先确认问题。";
  return `请先确认：${questions.map((item) => item && typeof item === "object" && "question" in item ? String(item.question) : "待确认事项").join("；")}。`;
}

function reviewDispositionHint(review: Pick<PrdReviewOutput, "summary">): string {
  if (review.summary.p0_count || review.summary.p1_count) return "审核存在阻塞问题，交付前需要先修复并重新审核。";
  if (review.summary.p2_count) return `存在 ${review.summary.p2_count} 个低优先级待办，不阻塞交付，但需要你明确是否接受。`;
  return "审核未发现阻塞问题，请确认是否交付当前版本。";
}

function requireState(taskId: string): TaskState {
  const state = readTaskState();
  if (!state || state.task_id !== taskId) throw new Error(`任务 ${taskId} 不存在`);
  return state;
}

function stateName(id: StateId): string {
  return loadStates().find((item) => item.id === id)?.name ?? id;
}

function extractExistingPath(message: string): string | undefined {
  const candidates = message.match(/\/[\w\-./\u4e00-\u9fff ]+/g) ?? [];
  return candidates.map((candidate) => candidate.trim()).find((candidate) => fs.existsSync(candidate));
}

function isPause(message: string): boolean {
  return /^(暂停|先停一下|稍后继续)$/.test(message.trim());
}

function isCancelTask(message: string): boolean {
  return /^(取消任务|结束任务|放弃任务)$/.test(message.trim());
}

function defaultProvider(): AgentProvider {
  loadLocalEnv();
  const provider = (process.env.MODEL_PROVIDER ?? "workspace").toLowerCase();
  if (provider === "openai") return OpenAIProvider.fromEnv();
  if (["deepseek", "kimi", "moonshot", "compatible", "openai-compatible"].includes(provider)) {
    const prefix = provider === "deepseek" ? "DEEPSEEK" : provider === "kimi" || provider === "moonshot" ? "KIMI" : "MODEL";
    const model = process.env[`${prefix}_MODEL`] ?? process.env.MODEL_ID ?? "";
    const apiKey = process.env[`${prefix}_API_KEY`] ?? "";
    const baseUrl = process.env[`${prefix}_BASE_URL`] ?? (provider === "deepseek" ? "https://api.deepseek.com" : provider === "kimi" || provider === "moonshot" ? "https://api.moonshot.cn/v1" : "");
    if (!baseUrl) throw new Error("启用 OpenAI 兼容 Provider 时必须配置 MODEL_BASE_URL");
    const timeout = Number(process.env[`${prefix}_TIMEOUT_MS`] ?? process.env.MODEL_TIMEOUT_MS ?? "120000");
    return new OpenAIProvider(new OpenAICompatibleClient({
      apiKey,
      model,
      baseUrl,
      timeoutMs: Number.isFinite(timeout) ? timeout : 120_000,
      providerId: provider === "moonshot" ? "kimi" : provider === "openai-compatible" ? "compatible" : provider,
      apiKeyName: `${prefix}_API_KEY`,
    }), model, provider === "moonshot" ? "kimi" : provider === "openai-compatible" ? "compatible" : provider, `${provider === "moonshot" ? "Kimi" : provider === "compatible" || provider === "openai-compatible" ? "兼容接口" : provider} Provider (${model})`);
  }
  if (["claude", "anthropic"].includes(provider)) {
    const model = process.env.CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.MODEL_ID ?? "";
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const timeout = Number(process.env.CLAUDE_TIMEOUT_MS ?? process.env.MODEL_TIMEOUT_MS ?? "120000");
    return new OpenAIProvider(new AnthropicMessagesClient({
      apiKey,
      model,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      timeoutMs: Number.isFinite(timeout) ? timeout : 120_000,
    }), model, "claude", `Claude Provider (${model})`);
  }
  return new WorkspaceProvider();
}

function normalizeProjectId(value?: string): string {
  const normalized = (value ?? "default-project").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("project_id 只能包含小写字母、数字、下划线或连字符，长度不超过 64");
  }
  return normalized;
}
