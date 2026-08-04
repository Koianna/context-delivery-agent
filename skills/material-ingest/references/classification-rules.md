# 信息分类规则

| 类型 | 判断标准 | 默认成熟度 |
|---|---|---|
| `USER_FEEDBACK` | 用户原话、工单或访谈反馈 | `UNCONFIRMED` |
| `OBSERVATION` | 基于多个现象形成但尚未验证的归纳 | `UNCONFIRMED` |
| `FACT` | 可由当前系统、文档或记录直接核验 | `CONFIRMED` 或 `UNCONFIRMED` |
| `DATA` | 有数值、样本和口径的数据 | 由来源完整性决定 |
| `OPINION` | 某个角色的主观看法 | `UNCONFIRMED` |
| `PROPOSAL` | 尚未批准的方案或动作建议 | `UNCONFIRMED` |
| `CONFIRMED_DECISION` | 有明确决策主体和确认动作的结论 | `CONFIRMED` |
| `OPEN_QUESTION` | 仍需回答且会影响后续工作的事项 | `UNCONFIRMED` |
| `DEPRECATED_CONTENT` | 已被明确替代或不再适用的内容 | `SUPERSEDED` |

## 层级规则

- 元数据完整且已明确确认的信息可建议进入 `CONTEXT`，但仍须通过 CP-C01。
- 未确认的事实、观察、提案和问题进入 `WORKSPACE`。
- 缺少来源负责人、来源时间或可定位证据的信息进入 `DRAFTS`。
- 历史材料不等于失效材料；只有存在明确失效依据时才标记 `DEPRECATED_CONTENT`。

## 证据规则

证据必须包含 `source_id`、`location` 和 `quote`。`quote` 应是足以支持该信息单元的最短原文，不能用分析结论替代原文。
