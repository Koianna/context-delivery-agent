import {
  readTaskState,
  writePendingConfirmations,
  writeTaskState,
} from "./config.js";
import type { StateId, TaskState } from "./types.js";

export interface CreateTaskInput {
  taskId: string;
  sessionId?: string;
  projectId?: string;
  mode?: TaskState["task_mode"];
  goal?: string;
  replaceTerminal?: boolean;
}

export function createTask(input: CreateTaskInput): TaskState {
  const existing = readTaskState();
  const replaceableStates: StateId[] = [
    "CONTEXT_TASK_COMPLETED",
    "DELIVERED",
    "TASK_CANCELLED",
  ];
  if (
    existing &&
    !(input.replaceTerminal && replaceableStates.includes(existing.current_state))
  ) {
    throw new Error(`任务已存在: ${existing.task_id}, 当前状态: ${existing.current_state}`);
  }

  const now = new Date().toISOString();
  const state: TaskState = {
    task_id: input.taskId,
    project_id: input.projectId ?? "default-project",
    session_id: input.sessionId ?? `session_${Date.now()}`,
    task_mode: input.mode ?? null,
    current_state: "INITIALIZING",
    previous_state: null,
    return_state: null,
    task_goal: input.goal ?? "",
    completed_steps: [],
    pending_confirmation: null,
    material_version: "0.1.0",
    context_version: "0.1.0",
    decision_ledger_version: "0.1.0",
    prd_version: "0.1.0",
    plan_version: "0.1.0",
    latest_output_ref: null,
    retry_count: 0,
    replan_count: 0,
    error_info: null,
    git_commit: null,
    prompt_versions: {},
    skill_versions: {},
    created_at: now,
    updated_at: now,
  };

  writeTaskState(state);
  writePendingConfirmations({ task_id: state.task_id, records: [] });
  return state;
}

export function updateTask(input: {
  taskId: string;
  mode?: TaskState["task_mode"];
  goal?: string;
}): TaskState {
  const state = readTaskState();
  if (!state || state.task_id !== input.taskId) {
    throw new Error(`任务 ${input.taskId} 不存在`);
  }
  if (input.mode !== undefined) state.task_mode = input.mode;
  if (input.goal !== undefined) state.task_goal = input.goal;
  writeTaskState(state);
  return state;
}
