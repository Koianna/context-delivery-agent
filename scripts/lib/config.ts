// ============================================================
// Context 工程与需求交付协作 Agent — 共享配置与工具
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  StateConfig,
  TransitionConfig,
  GuardsConfig,
  TaskState,
  PendingConfirmations,
  ConfirmationRecord,
  StateId,
  ConfirmationType,
} from "./types.js";

// ---- 路径 ----

export const PROJECT_ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "README.md")) &&
        fs.existsSync(path.join(dir, "state-machine"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();

export const RUNTIME_DIR = path.join(PROJECT_ROOT, "runtime");
export const STATE_MACHINE_DIR = path.join(PROJECT_ROOT, "state-machine");
// 项目本地缓存根目录（gitignore）。所有 Runtime 派生产物集中在此，
// context-workspace/ 只保留产品经理可读的 Markdown。
export const CACHE_ROOT_DIR = ".cache";
// Runtime 每次任务的中间产物（分析报告、草稿、候选），通过 runs:// scheme 引用。
export const AGENT_RUNS_DIR = `${CACHE_ROOT_DIR}/agent-runs`;
// 项目级派生 manifest 缓存，可从 drafts/<projectId>/source-materials/ 重建。
export const MANIFESTS_DIR = `${CACHE_ROOT_DIR}/manifests`;
// PRD 恢复快照根目录，用于灾难恢复和完整性校验。
export const PRD_RECOVERY_DIR = `${CACHE_ROOT_DIR}/prd-recovery`;

function runtimeFile(filename: string): string {
  return path.join(RUNTIME_DIR, filename);
}

export const TASK_STATE_FILE = runtimeFile("task-state.json");
export const PENDING_CONFIRMATIONS_FILE = runtimeFile("pending-confirmations.json");
export const TASK_EVENTS_FILE = runtimeFile("task-events.jsonl");

// ---- 状态机配置（延迟加载） ----

let _states: StateConfig[] | null = null;
let _transitions: TransitionConfig[] | null = null;
let _guards: GuardsConfig | null = null;

export function loadStates(): StateConfig[] {
  if (_states) return _states;
  _states = JSON.parse(
    fs.readFileSync(path.join(STATE_MACHINE_DIR, "states.json"), "utf-8")
  ) as StateConfig[];
  return _states;
}

export function loadTransitions(): TransitionConfig[] {
  if (_transitions) return _transitions;
  _transitions = JSON.parse(
    fs.readFileSync(path.join(STATE_MACHINE_DIR, "transitions.json"), "utf-8")
  ) as TransitionConfig[];
  return _transitions;
}

export function loadGuards(): GuardsConfig {
  if (_guards) return _guards;
  _guards = JSON.parse(
    fs.readFileSync(path.join(STATE_MACHINE_DIR, "guards.json"), "utf-8")
  ) as GuardsConfig;
  return _guards;
}

// ---- 运行时状态读写 ----

export function readTaskState(): TaskState | null {
  try {
    return JSON.parse(fs.readFileSync(TASK_STATE_FILE, "utf-8")) as TaskState;
  } catch {
    return null;
  }
}

export function writeTaskState(state: TaskState): void {
  state.updated_at = new Date().toISOString();
  // 原子写入：先写临时文件，再替换
  const tmp = TASK_STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, TASK_STATE_FILE);
}

export function readPendingConfirmations(): PendingConfirmations | null {
  try {
    return JSON.parse(
      fs.readFileSync(PENDING_CONFIRMATIONS_FILE, "utf-8")
    ) as PendingConfirmations;
  } catch {
    return null;
  }
}

export function writePendingConfirmations(pc: PendingConfirmations): void {
  const tmp = PENDING_CONFIRMATIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pc, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, PENDING_CONFIRMATIONS_FILE);
}

export function appendEvent(event: Record<string, unknown>): void {
  fs.appendFileSync(TASK_EVENTS_FILE, JSON.stringify(event) + "\n", "utf-8");
}

// ---- 校验 ----

export function isValidState(stateId: string): boolean {
  return loadStates().some((s) => s.id === stateId);
}

export function getLegalTransitions(fromState: StateId): TransitionConfig[] {
  return loadTransitions().filter((t) => t.from === fromState);
}

export function isLegalTransition(
  from: StateId,
  to: StateId
): TransitionConfig | null {
  return (
    loadTransitions().find((t) => t.from === from && t.to === to) ?? null
  );
}

export function getConfirmationTypeForState(
  stateId: StateId
): ConfirmationType | undefined {
  return loadGuards().confirmation_required_states[stateId];
}

export function stateRequiresConfirmation(stateId: StateId): boolean {
  return !!getConfirmationTypeForState(stateId);
}

export function getActiveConfirmation(
  taskId: string,
  stateId: StateId
): ConfirmationRecord | undefined {
  const pc = readPendingConfirmations();
  if (!pc || pc.task_id !== taskId) return undefined;
  return pc.records.find(
    (r) => r.current_state === stateId && r.status === "PENDING"
  );
}

export function getLatestConfirmation(
  taskId: string,
  stateId: StateId,
  type?: ConfirmationType
): ConfirmationRecord | undefined {
  const pc = readPendingConfirmations();
  if (!pc || pc.task_id !== taskId) return undefined;
  return [...pc.records]
    .reverse()
    .find(
      (record) =>
        record.current_state === stateId &&
        (!type || record.confirmation_type === type)
    );
}

export function hasPendingConfirmationForState(
  taskId: string,
  stateId: StateId
): boolean {
  return !!getActiveConfirmation(taskId, stateId);
}

/** 生成幂等键 */
export function idempotencyKey(taskId: string, sequence: string): string {
  return `${taskId}_${sequence}_${Date.now()}`;
}

/** 简易 UUID 生成 */
export function uid(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
