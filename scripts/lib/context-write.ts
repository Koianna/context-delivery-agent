import * as fs from "node:fs";
import type { ContextProposal } from "./context-types.js";
import type { ConfirmationRecord, TaskState } from "./types.js";
import { parseFrontmatter, repoRefToPath } from "./repository.js";

const STABLE_ACTIONS = new Set(["PROMOTE_TO_CONTEXT", "UPDATE_CONTEXT", "MARK_SUPERSEDED", "ARCHIVE"]);

export interface AuthorizationInput {
  taskState: TaskState;
  confirmations: ConfirmationRecord[];
  proposal: ContextProposal;
  root?: string;
}

export function authorizeContextWrite(input: AuthorizationInput): string[] {
  const { taskState, confirmations, proposal, root } = input;
  const errors: string[] = [];
  if (taskState.current_state !== "CONTEXT_MAINTAINING") {
    errors.push(`当前状态 ${taskState.current_state} 不允许稳定 Context 写入`);
  }
  if (!STABLE_ACTIONS.has(proposal.action)) {
    errors.push(`proposal ${proposal.proposal_id} 不是稳定 Context 动作`);
  }
  if (!proposal.target_ref?.startsWith("repo://context-workspace/context/")) {
    errors.push("目标路径必须位于 context-workspace/context/");
  }
  if (!proposal.source_refs.length) errors.push("稳定 Context 写入必须保留来源");

  const confirmation = [...confirmations].reverse().find(
    (record) =>
      record.confirmation_type === "CONTEXT_UPDATE" &&
      record.current_state === "WAITING_CONTEXT_CONFIRM"
  );
  const approvedItem = confirmation?.items.find(
    (item) =>
      item.proposal_id === proposal.proposal_id &&
      item.approval_status === "APPROVED"
  );
  if (
    !confirmation ||
    confirmation.task_id !== taskState.task_id ||
    confirmation.status !== "APPROVED" ||
    !approvedItem
  ) {
    errors.push(`proposal ${proposal.proposal_id} 没有逐项批准的 CP-C01 授权`);
  }

  let candidateBody: string | null = null;
  if (!proposal.content_ref) {
    errors.push(`proposal ${proposal.proposal_id} 缺少 content_ref`);
  } else {
    try {
      const contentPath = repoRefToPath(proposal.content_ref, root);
      if (!fs.existsSync(contentPath)) {
        errors.push(`候选内容不存在: ${proposal.content_ref}`);
      } else {
        candidateBody = parseFrontmatter(fs.readFileSync(contentPath, "utf-8")).body;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (proposal.target_ref) {
    try {
      const targetPath = repoRefToPath(proposal.target_ref, root);
      if (proposal.action === "UPDATE_CONTEXT" && !fs.existsSync(targetPath)) {
        errors.push(`UPDATE_CONTEXT 目标不存在: ${proposal.target_ref}`);
      }
      if (fs.existsSync(targetPath)) {
        const current = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
        const alreadyApplied = candidateBody !== null && current.body.trim() === candidateBody.trim();
        if (current.metadata.version !== proposal.base_version && !alreadyApplied) {
          errors.push(
            `基线版本冲突: 期望 ${proposal.base_version}, 当前 ${current.metadata.version ?? "missing"}`
          );
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
