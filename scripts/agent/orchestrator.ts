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
  readTaskState,
} from "../lib/config.js";
import type { ContextAnalysisOutput } from "../lib/context-types.js";
import type { PrdThinkingOutput, PrdWriteOutput } from "../lib/prd-types.js";
import { readJson, repoRefToPath } from "../lib/repository.js";
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
import { restoreCancelledChange } from "../restore-change-snapshot.js";
import { LocalCaseProvider } from "./local-case-provider.js";
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
  "WAITING_CONTEXT_CONFIRM",
  "WAITING_DECISION_CONFIRM",
  "WAITING_SCOPE_CONFIRM",
  "WAITING_REVIEW_DECISION",
  "WAITING_REPLAN_CONFIRM",
]);

export class AgentOrchestrator {
  constructor(private readonly provider: AgentProvider = new LocalCaseProvider()) {}

  handleMessage(message: string, options: HandleMessageOptions = {}): AgentResponse {
    const normalized = message.trim();
    if (!normalized) return this.blocked("请输入你希望整理的材料、要准备的 PRD，或要修改的内容。", options);

    try {
      let state = readTaskState();
      if (options.taskId && state && state.task_id !== options.taskId) {
        throw new Error(`当前运行任务是 ${state.task_id}，不是 ${options.taskId}`);
      }
      if (!state) state = this.initializeTask(normalized, options.taskId, options.sessionId);

      if (isPause(normalized)) return this.pause(state, options);
      if (state.current_state === "TASK_PAUSED") return this.resume(state, normalized, options);
      if (isCancelTask(normalized) && state.current_state !== "WAITING_REPLAN_CONFIRM") {
        return this.cancelTask(state, options);
      }

      if (WAITING_STATES.has(state.current_state)) {
        return this.handleWaitingState(state, normalized, options);
      }

      const intent = routeIntent(normalized);
      if (intent === "CONTINUE") return this.continueCurrent(state, options);
      if (intent === "UNKNOWN") return this.requestIntentClarification(state, normalized, options);
      return this.startIntent(state, intent, normalized, options);
    } catch (error) {
      return this.blocked(error instanceof Error ? error.message : String(error), options);
    }
  }

  private initializeTask(message: string, taskId?: string, sessionId?: string): TaskState {
    return createTask({
      taskId: taskId ?? `agent-${Date.now()}`,
      sessionId,
      projectId: "help-center-search",
      goal: message,
    });
  }

  private startIntent(
    state: TaskState,
    intent: Exclude<AgentIntent, "CONTINUE" | "UNKNOWN">,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    state = this.moveToRouting(state);
    if (intent === "CONTEXT") return this.startContext(state, message, options);
    if (intent === "PRD") return this.startPrd(state, message, options);
    return this.startChange(state, message, options);
  }

  private moveToRouting(state: TaskState): TaskState {
    if (state.current_state === "INITIALIZING") {
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "开始处理用户自然语言请求" });
    } else if (["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"].includes(state.current_state)) {
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "用户发起新任务" });
    }
    return requireState(state.task_id);
  }

  private startContext(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (state.current_state !== "INTENT_ROUTING") {
      throw new Error(`当前状态 ${state.current_state} 不能启动材料整理`);
    }
    updateTask({ taskId: state.task_id, mode: "CONTEXT", goal: message });
    assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "用户要求整理材料和维护 Context" });

    const materialPath = options.materialPath ?? extractExistingPath(message);
    const assets = this.provider.getContextAssets(materialPath);
    const reportRefs = this.provider.getContextReportRefs(state.task_id);
    const registered = registerMaterials(assets.inputPath);
    const recorded = recordContextAnalysis({
      taskId: state.task_id,
      materialInputPath: assets.inputPath,
      materialOutputPath: assets.materialOutputPath,
      contextOutputPath: assets.contextOutputPath,
      materialReportRef: reportRefs.materialReportRef,
      contextReportRef: reportRefs.contextReportRef,
    });
    const analysis = readJson<ContextAnalysisOutput>(assets.contextOutputPath);
    const confirmation = createConfirmation({
      taskId: state.task_id,
      type: "CONTEXT_UPDATE",
      state: "WAITING_CONTEXT_CONFIRM",
      sourceState: "CONTEXT_ANALYZING",
      title: "确认稳定 Context 更新建议",
      actions: ["APPROVE_ALL", "APPROVE_SELECTED", "DEFER_ALL", "REJECT_ALL"],
      items: analysis.update_proposals.map((proposal) => ({ ...proposal })),
    });
    assertTransition({ taskId: state.task_id, toState: "WAITING_CONTEXT_CONFIRM", reason: "稳定 Context 变更需要 CP-C01 人工确认" });

    return this.response({
      message: [
        `我已登记并分析 ${recorded.material_count} 份材料。`,
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
      ],
      confirmation,
      nextSteps: ["回复“确认全部”", "回复“只确认方案”或“只确认边界”", "回复“暂不更新稳定 Context”"],
      debug: options.debug,
    });
  }

  private startPrd(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (state.current_state === "INTENT_ROUTING") {
      updateTask({ taskId: state.task_id, mode: "PRD", goal: message });
      assertTransition({ taskId: state.task_id, toState: "PRD_THINKING", reason: "用户要求准备 PRD" });
    } else if (state.current_state === "CONTEXT_TASK_COMPLETED") {
      updateTask({ taskId: state.task_id, mode: "PRD", goal: message });
      assertTransition({ taskId: state.task_id, toState: "PRD_THINKING", reason: "Context 整理完成后继续 PRD" });
    } else {
      throw new Error(`当前状态 ${state.current_state} 不能启动 PRD 写前对齐`);
    }

    const assets = this.provider.getPrdAssets(state.task_id);
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
        `当前有 ${thinking.writable_assessment.blockers.length} 个阻塞决策：关键词别名维护责任、无查询词日志时的验证口径。`,
        "建议采用：运营维护、产品定义规则并审核；上线前用版本化典型查询集验证，生产指标待日志能力具备后补充。",
      ].join("\n"),
      status: "WAITING_CONFIRMATION",
      skill: "prd-thinking",
      artifacts: [{ ref: recorded.report_ref, label: "PRD 写前分析" }],
      confirmation,
      nextSteps: ["回复“按建议确认，可以生成 PRD”", "回复“暂停”保留当前任务"],
      debug: options.debug,
    });
  }

  private startChange(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (state.current_state !== "INTENT_ROUTING") {
      throw new Error(`当前状态 ${state.current_state} 不能启动变更分析`);
    }
    updateTask({ taskId: state.task_id, mode: "CHANGE", goal: message });
    assertTransition({ taskId: state.task_id, toState: "CHANGE_ANALYZING", reason: "用户提出已交付需求的实质变更" });
    let current = requireState(state.task_id);
    const analysisAssets = this.provider.prepareChangeAnalysis(current, message);
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
    const replanAssets = this.provider.prepareChangeReplan(current, analysisAssets);
    const replanResult = recordReplan(
      state.task_id,
      replanAssets.replanPath,
      PROJECT_ROOT,
      replanAssets.planRef
    );
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
        "影响分析判断这是规则级变化：只需修订 PRD 细节、重新审核，不重跑需求目标、范围和核心流程。",
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

  private handleWaitingState(
    state: TaskState,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    const confirmation = getActiveConfirmation(state.task_id, state.current_state);
    if (!confirmation) throw new Error(`等待状态 ${state.current_state} 缺少待确认记录`);
    if (state.current_state === "WAITING_INTENT_CLARIFICATION") {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "CONFIRM" });
      assertTransition({ taskId: state.task_id, toState: "INTENT_ROUTING", reason: "用户补充了任务意图" });
      return this.handleMessage(message, { ...options, taskId: state.task_id });
    }
    if (state.current_state === "WAITING_CONTEXT_CONFIRM") {
      return this.resolveContextConfirmation(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_DECISION_CONFIRM") {
      return this.resolveP01(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_SCOPE_CONFIRM") {
      return this.resolveP02(state, confirmation, message, options);
    }
    if (state.current_state === "WAITING_REVIEW_DECISION") {
      return this.resolveP03(state, confirmation, message, options);
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
    if (selected.mode === "DEFER") {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "DEFER_ALL" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_ANALYZING", reason: "用户暂不更新稳定 Context" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_MAINTAINING", reason: "仅保留可逆分析产物" });
      assertTransition({ taskId: state.task_id, toState: "CONTEXT_TASK_COMPLETED", reason: "材料整理完成，稳定 Context 未变更" });
      return this.response({
        message: "材料、分析报告和待确认问题已保留在 drafts/workspace；按你的决定，本次没有更新稳定 Context。",
        status: "COMPLETED",
        skill: "context-maintain",
        artifacts: [
          { ref: reportRefs.contextReportRef, label: "Context 分析报告" },
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
        result.executed_actions.length
          ? `已更新：${result.executed_actions.join("、")}。`
          : "候选内容与现有稳定 Context 一致，因此保持幂等，没有重复创建版本。",
        `仍有 ${result.health_check.remaining_issues.length} 个问题保留为待确认事项。`,
      ].join("\n"),
      status: "COMPLETED",
      skill: "context-maintain/APPLY",
      artifacts: [
        { ref: result.change_log_ref, label: "Context 变更记录" },
        { ref: "repo://context-workspace/context/INDEX.md", label: "稳定 Context 索引" },
      ],
      nextSteps: ["回复“继续准备 PRD”进入写前对齐", "回复新的材料整理任务"],
      debug: options.debug,
    });
  }

  private resolveP01(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (!/(确认|同意|按建议|可以生成|继续)/.test(message)) return this.confirmationReminder(confirmation, options);
    const assets = this.provider.getPrdAssets(state.task_id);
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "CONFIRM_WRITABLE" });
    recordConfirmedDecisions(
      state.task_id,
      assets.confirmedLedgerPath,
      PROJECT_ROOT,
      reportRefs.ledgerRef
    );
    assertTransition({ taskId: state.task_id, toState: "PRD_DRAFTING_CORE", reason: "CP-P01 已确认可写" });
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

  private resolveP02(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (!/(确认|同意|批准|继续)/.test(message)) return this.confirmationReminder(confirmation, options);
    const assets = this.provider.getPrdAssets(state.task_id);
    const reportRefs = this.provider.getPrdReportRefs(state.task_id);
    resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "APPROVE_CORE" });
    assertTransition({ taskId: state.task_id, toState: "PRD_DRAFTING_DETAILS", reason: "CP-P02 已确认范围和核心流程" });
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
        "两项 P2 已进入发布前待办，不阻塞当前版本交付，但需要你明确接受。",
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

  private resolveP03(
    state: TaskState,
    confirmation: ConfirmationRecord,
    message: string,
    options: HandleMessageOptions
  ): AgentResponse {
    if (/(修复|修改|先改)/.test(message)) {
      resolveConfirmation({ taskId: state.task_id, confirmationId: confirmation.confirmation_id, resolution: "FIX_AND_REVIEW" });
      assertTransition({ taskId: state.task_id, toState: "PRD_REVIEWING", reason: "用户要求先修复审核问题" });
      return this.response({
        message: "已记录“先修复再审核”。当前本地 Provider 不会替你决定 P2 的具体修订内容，任务停在重新审核节点。",
        status: "CONTINUE",
        skill: "prd-review",
        artifacts: [],
        nextSteps: ["补充具体修订决定后继续", "也可说“暂停”"],
        debug: options.debug,
      });
    }
    if (!/(接受|交付|确认|同意)/.test(message)) return this.confirmationReminder(confirmation, options);
    const assets = this.provider.getPrdAssets(state.task_id);
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
        "任务已返回 PRD 细节修订节点；目标、范围、核心流程和既有决策保持不变。",
        "当前本地 Provider 的自然语言 POC 在此停止自动写入，避免未经新的业务确认直接覆盖已交付 PRD。",
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

  private continueCurrent(state: TaskState, options: HandleMessageOptions): AgentResponse {
    if (state.current_state === "CONTEXT_TASK_COMPLETED") {
      return this.startPrd(state, "基于已整理的 Context 继续准备 PRD", options);
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

  private resume(state: TaskState, message: string, options: HandleMessageOptions): AgentResponse {
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
    return this.continueCurrent(resumed, options);
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

function routeIntent(message: string): AgentIntent {
  if (/^(继续|恢复|下一步)$/.test(message.trim())) return "CONTINUE";
  if (/(修改|变更|改成|调整已有|不要做|增加规则|下线|删除后)/.test(message)) return "CHANGE";
  if (/(只整理|整理材料|维护\s*context|先不写\s*prd|不生成\s*prd|资料归档|材料分析)/i.test(message)) return "CONTEXT";
  if (/(准备\s*prd|写\s*prd|生成\s*prd|需求文档|继续准备\s*prd)/i.test(message)) return "PRD";
  return "UNKNOWN";
}

function selectContextProposalIds(
  confirmation: ConfirmationRecord,
  message: string
): { mode: "APPROVE" | "DEFER"; ids: string[] } {
  if (/(暂不|先不|不更新|延后|忽略)/.test(message)) return { mode: "DEFER", ids: [] };
  if (/(全部|都确认|全确认)/.test(message)) {
    return { mode: "APPROVE", ids: proposalIds(confirmation.items) };
  }
  const selected: string[] = [];
  for (const item of confirmation.items) {
    const id = item.proposal_id;
    const text = `${item.proposed_value ?? ""} ${item.target_ref ?? ""}`;
    if (typeof id !== "string") continue;
    if (/(方案|关键词别名|搜索优化)/.test(message) && /(关键词别名|search-solution)/.test(text)) selected.push(id);
    if (/(边界|语义检索|智能问答)/.test(message) && /(语义检索|智能问答|search-boundaries)/.test(text)) selected.push(id);
  }
  if (!selected.length) throw new Error("没有识别出你批准的具体 Context 建议，请回复“确认全部”“只确认方案”“只确认边界”或“暂不更新”");
  return { mode: "APPROVE", ids: [...new Set(selected)] };
}

function proposalIds(items: ConfirmationRecord["items"]): string[] {
  return items.map((item) => item.proposal_id).filter((id): id is string => typeof id === "string");
}

function humanActions(confirmation: ConfirmationRecord): string[] {
  const type = confirmation.confirmation_type;
  if (type === "CONTEXT_UPDATE") return ["确认全部", "只确认方案", "只确认边界", "暂不更新稳定 Context"];
  if (type === "DECISION_AND_WRITABLE_STATUS") return ["按建议确认，可以生成 PRD"];
  if (type === "SCOPE_AND_CORE_FLOW") return ["确认范围和核心流程"];
  if (type === "REVIEW_DISPOSITION") return ["接受 P2 并交付", "先修复再审核"];
  if (type === "REPLAN_APPROVAL") return ["批准重规划", "修改重规划方案", "取消本次变更"];
  return ["补充明确的任务目标"];
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
