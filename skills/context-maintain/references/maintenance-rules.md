# Context 维护规则

## 关系判断

| 关系 | 含义 | 默认动作 |
|---|---|---|
| `NEW` | 当前 Context 没有同一知识 | 依据成熟度写 workspace 或建议提升 |
| `DUPLICATE` | 含义、适用范围和时效一致 | `NO_ACTION`，补来源即可 |
| `CONFLICT` | 同一条件下存在不能同时为真的陈述 | 保留双方证据，等待确认 |
| `SUPERSEDES` | 新结论明确替代旧结论 | 建议更新或标记旧内容失效 |
| `SUPPORTS` | 新证据支持现有内容 | `NO_ACTION` 或补充来源 |

## 稳定写入条件

同时满足以下条件才可生成 `PROMOTE_TO_CONTEXT`、`UPDATE_CONTEXT`、`MARK_SUPERSEDED` 或 `ARCHIVE`：

1. 信息成熟度为 `CONFIRMED`、`SUPERSEDED` 或 `ARCHIVED`；
2. 来源可定位，且来源元数据完整；
3. proposal 指定仓库内目标、基线版本和候选内容；
4. `requires_confirmation` 为 `true`；
5. APPLY 前存在逐项批准的 CP-C01 记录。

## 风险

- 改变产品范围、默认规则或后续 Agent 推理前提：`HIGH`。
- 补充已确认事实但不改变行为：`MEDIUM`。
- 修复索引和无歧义引用：`LOW`，仍需记录执行结果。
