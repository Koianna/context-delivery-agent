#!/usr/bin/env npx tsx
import { routeIntent, selectContextProposalIds } from "../scripts/agent/orchestrator.js";
import type { ConfirmationRecord } from "../scripts/lib/types.js";

const confirmation: ConfirmationRecord = {
  confirmation_id: "confirm-parser-eval",
  confirmation_type: "CONTEXT_UPDATE",
  task_id: "parser-eval",
  current_state: "WAITING_CONTEXT_CONFIRM",
  source_state: "CONTEXT_ANALYZING",
  return_state: "CONTEXT_TASK_COMPLETED",
  title: "确认稳定 Context 更新",
  items: [
    { proposal_id: "proposal-business-rule", item_id: "item-business-rule", proposed_value: "业务规则", approval_status: "PENDING" },
    { proposal_id: "proposal-meeting-note", item_id: "item-meeting-note", proposed_value: "会议记录", approval_status: "PENDING" },
  ],
  allowed_actions: ["APPROVE_ALL", "APPROVE_SELECTED", "DEFER_ALL", "REJECT_ALL"],
  status: "PENDING",
  resolved_by: null,
  resolved_at: null,
  resolution: null,
};

const cases = [
  {
    case_id: "CONFIRM-01",
    actual: selectContextProposalIds(confirmation, "只确认 item-business-rule，item-meeting-note 暂不更新稳定 Context"),
    expected: { mode: "APPROVE", ids: ["proposal-business-rule"], rejectedIds: [] },
    detail: "部分确认不会被负面措辞覆盖",
  },
  {
    case_id: "CONFIRM-02",
    actual: selectContextProposalIds(confirmation, "确认全部，但 proposal-meeting-note 暂不更新"),
    expected: { mode: "APPROVE", ids: ["proposal-business-rule"], rejectedIds: [] },
    detail: "全量确认会排除明确暂缓项",
  },
  {
    case_id: "CONFIRM-03",
    actual: routeIntent("请回滚 item-2-src-08467210f6"),
    expected: "CONTEXT_REVOKE",
    detail: "撤销稳定 Context 进入受控撤销分支",
  },
  {
    case_id: "CONFIRM-04",
    actual: routeIntent("帮我再总结下这份会议记录"),
    expected: "UNKNOWN",
    detail: "模糊任务仍要求澄清，不自动吞掉后续消息",
  },
  {
    case_id: "CONFIRM-05",
    actual: routeIntent("只整理这些材料，不修改已有需求，也不写 PRD"),
    expected: "CONTEXT",
    detail: "明确只整理优先于变更关键词",
  },
];

const passed = cases.filter((item) => JSON.stringify(item.actual) === JSON.stringify(item.expected)).length;
console.log(JSON.stringify({
  evaluation_id: "confirmation-parser",
  summary: { total: cases.length, passed, failed: cases.length - passed },
  results: cases.map((item) => ({ case_id: item.case_id, passed: JSON.stringify(item.actual) === JSON.stringify(item.expected), detail: item.detail })),
}, null, 2));
if (passed !== cases.length) process.exit(1);
