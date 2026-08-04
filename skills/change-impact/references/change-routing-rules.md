# 变更类型与最小返回节点

| 变更类型 | 推荐返回节点 | 必须重做 | 默认保留 |
|---|---|---|---|
| `SOURCE_CHANGE`、`FACT_CHANGE` | `CONTEXT_ANALYZING` | 来源核验、Context 影响分析 | 未受影响决策和 PRD 章节 |
| `GOAL_CHANGE`、`SCOPE_CHANGE` | `PRD_THINKING` | 背景、目标、范围和阻塞决策 | 可验证的历史材料 |
| `DECISION_CHANGE` | `PRD_THINKING` | 相关决策及下游章节 | 无关决策与 Context |
| `CORE_FLOW_CHANGE` | `PRD_DRAFTING_CORE` | 核心流程及全部下游细节 | 已确认背景、目标和非目标 |
| `DETAIL_RULE_CHANGE` | `PRD_DRAFTING_DETAILS` | 相关规则、异常、验收与审核 | 目标、范围、核心流程和无关决策 |
| `WORDING_ONLY` | `null` | 原节点局部表达修改 | 全部业务含义和版本基线 |
| `UNKNOWN` | `null` | 先澄清意图 | 全部现有产物 |

## 判断原则

- 返回“最早必要节点”，不是一律从头执行。
- 同一产物可以同时存在受影响章节和保留章节，必须分别列明位置。
- 已被新变化失效的审核报告保留历史，只标记为待替代。
- 任何推荐都只是草案，CP-R01 才能授权任务采用新计划。
