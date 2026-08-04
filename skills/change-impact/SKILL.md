---
name: change-impact
description: 在用户改变事实、目标、范围、决策、流程或规则时，基于不可变快照识别受影响与保留内容，并生成最小重跑计划。用于已有 Context、决策或 PRD 的修改与重规划；不直接覆盖业务产物，也不替用户批准返回节点。
---

# Change Impact

## ANALYZE

1. 读取变更请求、任务版本和快照清单，拒绝没有基线的分析。
2. 按 `references/change-routing-rules.md` 判断变更类型和是否属于实质变化。
3. 分别列出受影响内容与应保留内容，定位到产物和章节。
4. 推荐最早必要返回节点，避免无差别从头执行。
5. 返回影响报告，不编辑 Context、决策账本、PRD 或审核报告。

## REPLAN

1. 读取已校验的影响报告并核对内容哈希。
2. 生成带前序版本的新计划草案，明确步骤、依赖和确认点。
3. 标记保留产物、待替代产物、风险和开放问题。
4. 将草案提交 CP-R01；未经确认不改变任务返回节点和业务版本。

## 边界

- `UNKNOWN` 不得自动选择返回节点。
- `WORDING_ONLY` 不进入完整重规划，只建议原节点局部修改。
- 影响分析和计划草案只允许写入 `workspace/reports` 与 `workspace/plans`。
- 取消变更时通过 Harness 从快照恢复，不由 Skill 自行回滚。

## 资源

- 变更路由规则：`references/change-routing-rules.md`
- 核心提示：`prompt.md`
- 输出契约：`schema.json`
- 示例：`examples/detail-rule-change.json`
