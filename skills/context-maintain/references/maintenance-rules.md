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

## 局部降级

- 指定章节从稳定 Context 移到 workspace 时使用 `UPDATE_CONTEXT`，不能用 `ARCHIVE` 替代。
- `content_ref` 保存删除指定章节后的稳定候选，`workspace_ref` 保存被移出的原章节，`section_titles` 记录章节标题。
- 未指定章节必须保留；局部更新导致正文为空时停止执行，要求用户改用整文件归档。
- `INDEX.md` 是派生索引，只能由 `update-index` 更新，不能成为人工撤销或局部更新 proposal。

## 风险

- 改变产品范围、默认规则或后续 Agent 推理前提：`HIGH`。
- 补充已确认事实但不改变行为：`MEDIUM`。
- 修复索引和无歧义引用：`LOW`，仍需记录执行结果。
