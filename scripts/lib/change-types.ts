import type { StateId } from "./types.js";

export type ChangeType =
  | "SOURCE_CHANGE"
  | "FACT_CHANGE"
  | "GOAL_CHANGE"
  | "SCOPE_CHANGE"
  | "DECISION_CHANGE"
  | "CORE_FLOW_CHANGE"
  | "DETAIL_RULE_CHANGE"
  | "WORDING_ONLY"
  | "UNKNOWN";

export type ReplanReturnState =
  | "CONTEXT_ANALYZING"
  | "PRD_THINKING"
  | "PRD_DRAFTING_CORE"
  | "PRD_DRAFTING_DETAILS";

export interface ChangeRequestInput {
  request_meta: {
    request_id: string;
    project_id: string;
    task_id: string;
    current_state: StateId;
    triggered_by: "USER" | "AGENT" | "SYSTEM";
    requested_at: string;
  };
  change_request: {
    change_id: string;
    change_text: string;
    change_source: "USER" | "AGENT" | "SYSTEM";
    received_at: string;
    source_refs: string[];
  };
  task_snapshot: {
    source_state: StateId;
    material_version: string;
    context_version: string;
    decision_ledger_version: string;
    prd_version: string;
    plan_version: string;
  };
  artifact_refs: string[];
  confirmed_decision_refs: string[];
}

export interface ImpactItem {
  item_id: string;
  artifact_ref: string;
  locations: string[];
  impact_type?: "REWRITE_REQUIRED" | "REVIEW_INVALIDATED" | "DECISION_RECONFIRM_REQUIRED" | "CONTEXT_REVALIDATION_REQUIRED";
  reason: string;
}

export interface ChangeAnalysisOutput {
  mode: "ANALYZE";
  change_id: string;
  snapshot_ref: string;
  change_classification: {
    change_type: ChangeType;
    is_material_change: boolean;
    confidence: number;
  };
  change_summary: {
    old_value: string;
    new_value: string;
    source_refs: string[];
  };
  affected_items: ImpactItem[];
  unaffected_items: ImpactItem[];
  recommended_return_state: ReplanReturnState | null;
  risks: string[];
  open_questions: string[];
}

export interface ReplanStep {
  step_id: string;
  state: StateId;
  action: string;
  input_refs: string[];
  depends_on: string[];
}

export interface ReplanOutput {
  mode: "REPLAN";
  change_id: string;
  analysis_ref: string;
  analysis_sha256: string;
  snapshot_ref: string;
  plan: {
    plan_id: string;
    version: string;
    previous_version: string;
    status: "DRAFT" | "APPROVED";
    recommended_return_state: ReplanReturnState;
    steps: ReplanStep[];
    preserved_artifacts: string[];
    preserved_items: Array<{ artifact_ref: string; locations: string[] }>;
    deprecated_artifacts: string[];
    required_confirmations: string[];
  };
  risks: string[];
  open_questions: string[];
}

export interface ChangeSnapshotManifest {
  snapshot_id: string;
  manifest_version: "0.1.0";
  change_id: string;
  task_id: string;
  source_state: StateId;
  created_at: string;
  baseline_versions: ChangeRequestInput["task_snapshot"];
  artifacts: Array<{
    artifact_ref: string;
    snapshot_ref: string;
    sha256: string;
    size_bytes: number;
  }>;
}
