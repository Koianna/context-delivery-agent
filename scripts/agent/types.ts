import type { PrdSourceCategory } from "../lib/prd-types.js";
import type { ConfirmationRecord, StateId, TaskState } from "../lib/types.js";

export type AgentIntent = "CONTEXT" | "CONTEXT_REVOKE" | "PRD" | "CHANGE" | "CONTENT_REVISE" | "CONTINUE" | "UNKNOWN";
export type AgentStatus = "CONTINUE" | "WAITING_CONFIRMATION" | "COMPLETED" | "BLOCKED";
export type RuntimeExecutionStatus = "IN_PROGRESS" | "WAITING_USER_CONFIRMATION" | "COMPLETED" | "BLOCKED" | "CANCELLED" | "ERROR";

export interface AgentArtifact {
  ref: string;
  label: string;
}

export interface AgentResponse {
  message: string;
  state: {
    id: StateId;
    name: string;
    type: string;
  };
  status: AgentStatus;
  execution_authority: "RUNTIME_ONLY";
  execution_status: RuntimeExecutionStatus;
  result_is_authoritative: true;
  external_agent_instruction: string;
  provider: {
    id: string;
    label: string;
  };
  skill?: string;
  artifacts: AgentArtifact[];
  confirmation?: {
    id: string;
    title: string;
    actions: string[];
    items: ConfirmationRecord["items"];
  };
  next_steps: string[];
  debug?: {
    task_id: string;
    state_id: StateId;
  };
}

export interface HandleMessageOptions {
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  materialPath?: string;
  debug?: boolean;
}

export interface PrdProviderContext {
  userConfirmation?: string;
  revisionDecisions?: string;
}

/** 喂给 prd-thinking 的资料来源元数据：ref + 分类 + 已知成熟度 */
export interface PrdSourceMeta {
  ref: string;
  category: PrdSourceCategory;
  maturity?: string;
  note?: string;
}

export interface PrdProviderAssets {
  thinkingPath: string;
  confirmedLedgerPath: string;
  corePath: string;
  detailsPath: string;
  reviewTemplatePath: string;
  thinkingSourceMeta: PrdSourceMeta[];
  p01: Record<string, unknown>;
  p02: Record<string, unknown>;
  p03: Record<string, unknown>;
  prdRef: string;
}

export type PrdProviderPhase = "THINKING" | "CORE" | "DETAILS" | "REVISION" | "REFERENCE";

export interface ChangeAnalysisAssets {
  inputPath: string;
  analysisPath: string;
  reportRef: string;
  changeId: string;
}

export interface ChangeReplanAssets {
  replanPath: string;
  planRef: string;
  approval: Record<string, unknown>;
}

export type ProviderResult<T> = T | Promise<T>;

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly generationMode: "workspace" | "model";
  setProjectId?(projectId: string): void;
  getContextAssets(materialPath?: string, taskId?: string, taskGoal?: string): ProviderResult<{
    inputPath: string;
    materialOutputPath: string;
    contextOutputPath: string;
    structuredMaterialPath: string;
  }>;
  getContextReportRefs(taskId: string, structuredMaterialPath?: string): {
    materialReportRef: string;
    contextReportRef: string;
    structuredMaterialRef: string;
    changeLogRef: string;
  };
  getPrdAssets(taskId: string, phase?: PrdProviderPhase, context?: PrdProviderContext): ProviderResult<PrdProviderAssets>;
  getPrdReportRefs(taskId: string): {
    thinkingRef: string;
    ledgerRef: string;
    reviewRef: string;
  };
  prepareChangeAnalysis(state: TaskState, message: string, deliveredPrdTaskId?: string): ProviderResult<ChangeAnalysisAssets>;
  prepareChangeReplan(state: TaskState, assets: ChangeAnalysisAssets): ProviderResult<ChangeReplanAssets>;
}
