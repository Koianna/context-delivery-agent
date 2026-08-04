# PRD 审核标准

## 维度

- `FACT_STATUS`：事实是否有来源，待确认内容是否被包装成事实。
- `SCOPE`：本期范围、非目标和正文规则是否一致。
- `COMPLETENESS`：关键角色、流程、状态和异常是否足以执行。
- `ACCEPTANCE`：验收是否可观察、可重复且不依赖主观判断。
- `DEPENDENCY`：上下游能力、责任人和约束是否明确。
- `CONSISTENCY`：章节之间、PRD 与决策之间是否冲突。
- `OVER_DESIGN`：是否加入未经确认的能力或实现细节。

## 严重级别

- `P0`：会导致方向错误、合规风险或完全无法交付。
- `P1`：会造成核心流程错误、范围冲突或无法验收，交付前必须修复。
- `P2`：局部完整性或表达问题，可由用户决定修复时机。

## 建议枚举

- `PASS`
- `PASS_WITH_NOTES`
- `FIX_BEFORE_DELIVERY`
- `REPLAN_REQUIRED`
