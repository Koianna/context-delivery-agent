---
name: prd-thinking
description: 在编写 PRD 前读取稳定 Context、当前材料和历史决策，生成背景理解卡、决策账本与可写状态，识别最多三个阻塞问题。用户明确要求准备 PRD，但目标、范围、关键决策或依赖仍需对齐时使用；不用于输出 PRD 正文或替用户决定业务取舍。
---

# PRD Thinking

## 工作流

1. 按 `references/writable-rules.md` 读取最小必要 Context、workspace 和历史 PRD。
2. 生成背景理解卡，区分已确认事实、已确认范围、未决问题和冲突。
3. 将会改变功能、权限、流程或验收的事项拆成决策账本条目。
4. 评估目标、范围、依赖和阻塞决策，输出 `READY`、`NEEDS_CONFIRMATION` 或 `BLOCKED`。
5. 最多提出三个优先问题，每个问题说明影响和建议选项。
6. 按 `schema.json` 返回 JSON，不输出 PRD 章节正文。

## 边界

- 不决定需求是否值得做或业务优先级。
- `PENDING` 决策不能被默认值自动转成 `CONFIRMED`。
- 没有来源的信息只能是建议或待确认项。
- 不写入稳定 Context，不生成 PRD。

## 资源

- 可写状态规则：`references/writable-rules.md`
- 核心提示：`prompt.md`
- 输出契约：`schema.json`
- 最小示例：`examples/minimal-output.json`
