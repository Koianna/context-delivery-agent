---
name: material-ingest
description: 登记并分析产品材料，提取带来源证据的信息单元，区分事实、反馈、观察、提案、确认决策和待确认问题。用户要求整理会议纪要、用户反馈、历史需求或现状资料，且结果需要进入 Context 工作区时使用；不用于生成 PRD 或直接修改稳定 Context。
---

# Material Ingest

## 工作流

1. 读取输入清单中的全部材料，只处理 `analysis_scope` 允许的来源。
2. 按 `references/classification-rules.md` 切分和分类信息单元。
3. 每个信息单元保留 `source_refs` 与逐字证据；无法定位来源的判断标记为待确认，不能包装成事实。
4. 缺少来源负责人或时间的材料仍可分析，但其中信息最多进入 `DRAFTS`。
5. 按 `schema.json` 返回结构化 JSON，并核对汇总计数。

## 输出边界

- 不依据措辞强弱推断信息已确认。
- 不解决材料之间的冲突；将各自陈述完整输出，交给 `context-maintain`。
- 不生成 PRD、方案优先级或业务价值结论。
- 不写入 `context-workspace/context/`。

## 资源

- 分类与成熟度规则：`references/classification-rules.md`
- 输出契约：`schema.json`
- 提示模板：`prompt.md`
- 最小示例：`examples/minimal-output.json`
