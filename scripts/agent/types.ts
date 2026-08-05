import type { ConfirmationRecord, StateId, TaskState } from "../lib/types.js";

export type AgentIntent = "CONTEXT" | "PRD" | "CHANGE" | "CONTINUE" | "UNKNOWN";
export type AgentStatus = "CONTINUE" | "WAITING_CONFIRMATION" | "COMPLETED" | "BLOCKED";

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
  materialPath?: string;
  debug?: boolean;
}

export interface PrdProviderAssets {
  thinkingPath: string;
  confirmedLedgerPath: string;
  corePath: string;
  detailsPath: string;
  reviewTemplatePath: string;
  p01: Record<string, unknown>;
  p02: Record<string, unknown>;
  p03: Record<string, unknown>;
  prdRef: string;
}

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

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  getContextAssets(materialPath?: string): {
    inputPath: string;
    materialOutputPath: string;
    contextOutputPath: string;
  };
  getContextReportRefs(taskId: string): {
    materialReportRef: string;
    contextReportRef: string;
    changeLogRef: string;
  };
  getPrdAssets(taskId: string): PrdProviderAssets;
  getPrdReportRefs(taskId: string): {
    thinkingRef: string;
    ledgerRef: string;
    reviewRef: string;
  };
  prepareChangeAnalysis(state: TaskState, message: string): ChangeAnalysisAssets;
  prepareChangeReplan(state: TaskState, assets: ChangeAnalysisAssets): ChangeReplanAssets;
}
