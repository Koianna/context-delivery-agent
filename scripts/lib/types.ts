// ============================================================
// Context 工程与需求交付协作 Agent — 共享类型定义
// ============================================================

/** 24 个状态枚举 */
export type StateId =
  | "INITIALIZING"
  | "WAITING_RESUME_CHOICE"
  | "INTENT_ROUTING"
  | "WAITING_INTENT_CLARIFICATION"
  | "WAITING_MATERIAL_REPROCESS_CONFIRM"
  | "CONTEXT_ANALYZING"
  | "WAITING_CONTEXT_CONFIRM"
  | "CONTEXT_MAINTAINING"
  | "CONTEXT_TASK_COMPLETED"
  | "PRD_THINKING"
  | "WAITING_DECISION_CONFIRM"
  | "PRD_DRAFTING_CORE"
  | "WAITING_SCOPE_CONFIRM"
  | "PRD_DRAFTING_DETAILS"
  | "PRD_REVIEWING"
  | "WAITING_REVIEW_DECISION"
  | "WAITING_PRD_RECOVERY_CONFIRM"
  | "DELIVERED"
  | "CHANGE_ANALYZING"
  | "REPLANNING"
  | "WAITING_REPLAN_CONFIRM"
  | "TASK_PAUSED"
  | "EXECUTION_BLOCKED"
  | "TASK_CANCELLED";

export type TaskMode = "CONTEXT" | "PRD" | "CHANGE" | null;

export type Operator = "USER" | "AGENT" | "SYSTEM";

export type EventType =
  | "STATE_TRANSITION"
  | "SKILL_CALL"
  | "SKILL_RESULT"
  | "USER_CONFIRMATION"
  | "ARTIFACT_CREATED"
  | "ARTIFACT_RECOVERED"
  | "VERSION_CREATED"
  | "ERROR"
  | "TASK_PAUSED"
  | "TASK_RESUMED"
  | "TASK_CANCELLED";

export type ConfirmationType =
  | "RESUME_CHOICE"
  | "INTENT_CLARIFICATION"
  | "MATERIAL_REPROCESS"
  | "CONTEXT_UPDATE"
  | "DECISION_AND_WRITABLE_STATUS"
  | "SCOPE_AND_CORE_FLOW"
  | "REVIEW_DISPOSITION"
  | "PRD_ARTIFACT_RECOVERY"
  | "REPLAN_APPROVAL";

export type ConfirmationStatus = "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED" | "CANCELLED";

export interface ConfirmationItem {
  proposal_id?: string;
  approval_status?: "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED";
  [key: string]: unknown;
}

/** 任务状态快照 (runtime/task-state.json) */
export interface TaskState {
  task_id: string;
  project_id: string;
  session_id: string;
  task_mode: TaskMode;
  current_state: StateId;
  previous_state: StateId | null;
  return_state: StateId | null;
  task_goal: string;
  completed_steps: string[];
  pending_confirmation: string | null;
  material_version: string;
  context_version: string;
  decision_ledger_version: string;
  prd_version: string;
  plan_version: string;
  latest_output_ref: string | null;
  retry_count: number;
  replan_count: number;
  error_info: string | null;
  git_commit: string | null;
  prompt_versions: Record<string, string>;
  skill_versions: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** 人工确认记录 */
export interface ConfirmationRecord {
  confirmation_id: string;
  confirmation_type: ConfirmationType;
  task_id: string;
  current_state: StateId;
  source_state: StateId | null;
  return_state: StateId | null;
  title: string;
  items: ConfirmationItem[];
  allowed_actions: string[];
  status: ConfirmationStatus;
  resolved_by: Operator | null;
  resolved_at: string | null;
  resolution: string | null;
}

/** 确认记录集合 (runtime/pending-confirmations.json) */
export interface PendingConfirmations {
  task_id: string;
  records: ConfirmationRecord[];
}

/** 任务事件 (runtime/task-events.jsonl 中的单行) */
export interface TaskEvent {
  event_id: string;
  event_type: EventType;
  task_id: string;
  request_id: string;
  idempotency_key: string;
  timestamp: string;
  operator: Operator;
  current_state: StateId;
  previous_state: StateId | null;
  skill_name: string | null;
  skill_version: string | null;
  prompt_version: string | null;
  artifact_ref: string | null;
  details: Record<string, unknown>;
  reason?: string;
}

/** 状态定义 (state-machine/states.json) */
export interface StateConfig {
  id: StateId;
  name: string;
  type: "entry" | "execution" | "waiting" | "terminal" | "control";
}

/** 状态转移规则 (state-machine/transitions.json) */
export interface TransitionConfig {
  from: StateId;
  to: StateId | "PREVIOUS_STATE" | "PREVIOUS_VALID_STATE";
  guard: string;
}

/** 守卫条件 (state-machine/guards.json) */
export interface GuardsConfig {
  confirmation_required_states: Partial<Record<StateId, ConfirmationType>>;
  context_return_whitelist: Record<string, StateId[]>;
  prd_entry_guard: {
    writable_status: boolean;
    goal_confirmed: boolean;
    scope_confirmed: boolean;
    blocking_decisions_resolved: boolean;
  };
  max_retry: number;
  max_replan: number;
}

export type TransitionResult =
  | { ok: true; from: StateId; to: StateId; reason: string }
  | { ok: false; from: StateId; requested: string; error: string };
