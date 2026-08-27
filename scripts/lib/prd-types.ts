/** 资料状态分层：来源资料的分类（对应 PRD skills.md 的"资料状态分层表"） */
export type PrdSourceCategory =
  | "stable_context" // 稳定 Context（已确认知识）
  | "historical_prd" // 历史 PRD（workspace/prd/，草稿级）
  | "material_analysis" // 本次材料分析报告（含 maturity 分层）
  | "user_material" // 用户显式上传的原始材料（PRD/规划/讨论稿）
  | "decision_ledger" // 已确认决策账本
  | "external_standard"; // 外部标准或法规资料

/** 资料采用方式 */
export type PrdSourceAdoption =
  | "default_adopt" // 默认采用（稳定 Context / 已确认事实）
  | "reference_only" // 仅作参考
  | "needs_confirmation" // 需用户确认
  | "verify_version"; // 需核验版本

/** 资料状态分层表条目（四列：资料 / 类型状态 / 本次用途 / 采用方式与风险） */
export interface PrdMaterialClassification {
  source_ref: string;
  category: PrdSourceCategory;
  usage: string; // 本次用途
  adoption: PrdSourceAdoption; // 采用方式
  risk?: string; // 采用方式与风险
}

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
    material_classification?: PrdMaterialClassification[];
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
