# PRD 审核标准

> **配置文件**：业务规则的单一事实来源在 `delivery-rules.json`，本文档为人类可读版本。

## 维度

见 `delivery-rules.json` 的 `reviewDimensions`，共 7 个维度：

- `FACT_STATUS`：事实是否有来源，待确认内容是否被包装成事实。
- `SCOPE`：本期范围、非目标和正文规则是否一致。
- `COMPLETENESS`：关键角色、流程、状态和异常是否足以执行。
- `ACCEPTANCE`：验收是否可观察、可重复且不依赖主观判断。
- `DEPENDENCY`：上下游能力、责任人和约束是否明确。
- `CONSISTENCY`：章节之间、PRD 与决策之间是否冲突。
  - 子维度：术语一致性、交互模式一致性、信息架构一致性、设计语言一致性、组件复用性、业务规则一致性
- `OVER_DESIGN`：是否加入未经确认的能力或实现细节。

## 严重级别

见 `delivery-rules.json` 的 `severityLevels`：

- `P0`：会导致方向错误、合规风险或完全无法交付。
- `P1`：会造成核心流程错误、范围冲突或无法验收，交付前必须修复。
- `P2`：局部完整性或表达问题，可由用户决定修复时机。

## 交付建议枚举

见 `delivery-rules.json` 的 `deliveryRules.allowedRecommendations`：

- 存在 P0 或 P1 时：`FIX_BEFORE_DELIVERY`、`REPLAN_REQUIRED`
- 仅存在 P2 时：`PASS_WITH_NOTES`、`FIX_BEFORE_DELIVERY`
- 无问题时：`PASS`、`PASS_WITH_NOTES`

## 减法审查清单（功能必要性评估）

见 `delivery-rules.json` 的 `reductionChecklist`，7 个维度：

| 维度 | 关键问题 | 不通过的信号 |
|------|---------|-------------|
| 必要性 | 如果不做，用户会怎样？ | "也能用，就是不太方便" |
| 频次 | 用户多久用一次？ | "一年用不到几次" |
| 用户量 | 多少比例的用户需要？ | "只有个别客户提过" |
| 问题定义 | 真的理解用户要解决的问题吗？ | "只知道用户说想要 X" |
| 替代方案 | 有没有更简单的方式？ | "没认真想过" |
| 时机 | 现在是最佳时机吗？ | "先做了再说" |
| 维护成本 | 后续维护成本多少？ | "只算了开发成本" |

## 问题必需字段

见 `delivery-rules.json` 的 `issueRequirements`：

- 必须有 location（定位）
- 必须有 description（描述）
- 必须有 impact（影响）
- 必须有 recommended_fix（建议修复方案）
