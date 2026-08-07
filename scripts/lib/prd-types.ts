export interface DecisionEntry {
  decision_id: string;
  question: string;
  status: "CONFIRMED" | "PENDING" | "BLOCKED" | "SUPERSEDED";
  is_blocking: boolean;
  human_decision: string | null;
  source_refs?: string[];
  [key: string]: unknown;
}

export interface PrdThinkingOutput {
  background_card: {
    materials_read: string[];
    source_refs: string[];
    [key: string]: unknown;
  };
  decision_ledger: DecisionEntry[];
  writable_assessment: {
    status: "READY" | "NEEDS_CONFIRMATION" | "BLOCKED";
    checks: Record<string, boolean>;
    blockers: string[];
    priority_questions: unknown[];
  };
}

export interface DecisionLedgerEntry {
  decision_id: string;
  status: "CONFIRMED" | "PENDING" | "BLOCKED" | "SUPERSEDED";
  [key: string]: unknown;
}

export interface ConfirmedDecisionLedger {
  artifact_id: string;
  version: string;
  decisions: DecisionLedgerEntry[];
  [key: string]: unknown;
}

export interface PrdArtifactDescriptor {
  artifact_id: string;
  version: string;
  previous_version: string | null;
  phase: "CORE" | "DETAILS" | "REVISION";
  structured_sections: string[];
  markdown_ref: string;
  content_ref: string;
  source_refs: string[];
  decision_refs: string[];
}

export interface PrdWriteOutput {
  prd_artifact: PrdArtifactDescriptor;
  coverage: {
    required_sections: string[];
    covered_sections: string[];
    missing_sections: string[];
  };
  unresolved_items: unknown[];
  unsupported_claims: unknown[];
  change_summary: string;
}

export interface PrdReviewOutput {
  review_id: string;
  reviewed_prd_version: string;
  prd_sha256: string;
  issues: Array<{
    issue_id: string;
    severity: "P0" | "P1" | "P2";
    dimension: string;
    location: string;
    description: string;
    evidence: unknown[];
    impact: string;
    recommended_fix: string;
    requires_replan: boolean;
  }>;
  summary: {
    p0_count: number;
    p1_count: number;
    p2_count: number;
    recommendation: "PASS" | "PASS_WITH_NOTES" | "FIX_BEFORE_DELIVERY" | "REPLAN_REQUIRED";
  };
  passed_dimensions: string[];
  unverifiable_items: unknown[];
}

export type PrdReviewTemplate = Omit<PrdReviewOutput, "prd_sha256">;
