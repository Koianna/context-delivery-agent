---
name: prd-review
description: 以独立审核立场检查完整 PRD 的事实状态、范围、完整性、验收、依赖、一致性和过度设计，输出可定位的分级问题与交付建议。PRD DETAILS 完成后或修订后需要质量门禁时使用；只读 PRD 和 Context，不直接修改正文。
---

# PRD Review

## 工作流

1. 记录待审核 PRD 的路径、版本和内容哈希。
2. 按 `references/review-rubric.md` 逐维度检查 PRD、Context 和确认决策。
3. 每个问题提供位置、依据、影响、建议和是否需要重规划。
4. 无法由现有来源验证的内容放入 `unverifiable_items`，不臆测为错误。
5. 汇总 P0/P1/P2 数量并给出交付建议。
6. 审核后再次核对 PRD 哈希，确保未修改正文。

## 边界

- 不直接编辑 PRD。
- 不推翻人工确认决策；发现决策冲突时标记并交给人处理。
- P0/P1 默认阻止直接交付；方向性问题设置 `requires_replan: true`。
- P2 可以由用户在 CP-P03 决定修复或带已知事项交付。

## 资源

- 审核标准：`references/review-rubric.md`
- 核心提示：`prompt.md`
- 输出契约：`schema.json`
- 示例：`examples/minimal-review.json`
