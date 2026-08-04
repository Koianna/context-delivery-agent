export type InformationType =
  | "USER_FEEDBACK"
  | "OBSERVATION"
  | "FACT"
  | "DATA"
  | "OPINION"
  | "PROPOSAL"
  | "CONFIRMED_DECISION"
  | "OPEN_QUESTION"
  | "DEPRECATED_CONTENT";

export type Maturity = "RAW" | "UNCONFIRMED" | "CONFIRMED" | "SUPERSEDED" | "ARCHIVED";
export type TargetLayer = "DRAFTS" | "WORKSPACE" | "CONTEXT";
export type ContextAction =
  | "WRITE_DRAFT"
  | "WRITE_WORKSPACE"
  | "PROMOTE_TO_CONTEXT"
  | "UPDATE_CONTEXT"
  | "MARK_SUPERSEDED"
  | "ARCHIVE"
  | "UPDATE_INDEX"
  | "FIX_REFERENCE"
  | "NO_ACTION";

export interface MaterialInput {
  source_id: string;
  name: string;
  source_type: string;
  source_owner: string | null;
  source_time: string | null;
  content_ref: string;
  is_complete: boolean;
}

export interface MaterialIngestInput {
  task_goal: string;
  analysis_scope: {
    topic: string;
    included_source_ids: string[];
  };
  materials: MaterialInput[];
}

export interface InformationItem {
  item_id: string;
  content: string;
  information_type: InformationType;
  maturity: Maturity;
  source_refs: string[];
  evidence: Array<{ source_id: string; location: string; quote: string }>;
  target_layer: TargetLayer;
  confidence: number;
  requires_confirmation: boolean;
}

export interface MaterialIngestOutput {
  material_records: Array<{
    source_id: string;
    topic: string;
    processing_status: "PROCESSED" | "PARTIAL" | "FAILED";
    missing_metadata: string[];
  }>;
  information_items: InformationItem[];
  processing_summary: {
    material_count: number;
    processed_count: number;
    failed_count: number;
    information_item_count: number;
  };
  failed_materials: unknown[];
}

export interface ContextProposal {
  proposal_id: string;
  action: ContextAction;
  target_ref: string | null;
  item_id: string;
  current_value: unknown;
  proposed_value: unknown;
  source_refs: string[];
  relationship: "NEW" | "DUPLICATE" | "CONFLICT" | "SUPERSEDES" | "SUPPORTS";
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  requires_confirmation: boolean;
  impact_if_applied: string;
  impact_if_ignored: string;
  base_version?: string | null;
  content_ref?: string | null;
}

export interface ContextAnalysisOutput {
  action: "ANALYZE";
  update_proposals: ContextProposal[];
  conflicts: unknown[];
  stale_items: unknown[];
  index_issues: unknown[];
  auto_actions: string[];
  remaining_questions: unknown[];
}
