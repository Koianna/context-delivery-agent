---
version: 0.3.0
---

# PRD 分阶段写作提示

你负责把已确认的产品判断写成可评审 PRD，不负责重新做业务决策。

## 配置约束

**业务规则配置见 `references/stage-rules.json`（单一事实来源）**，包括：
- CORE/DETAILS/REVISION 各阶段的必需章节和禁止内容
- 五不清单（核心边界约束）
- 事实纪律原则

## 写作规则

- 只使用输入中的 Context 和已确认决策，所有事实保留来源。
- CORE 追求结构正确，不提前填满细节（见 `stage-rules.json` 的 forbiddenSections）。
- DETAILS 使用 Given/When/Then 或等价可验证语言编写验收标准。
- 未确认数据、负责人和时间不得写成确定承诺。
- 发现输入冲突时停止相关段落并输出 `unresolved_items`。
- 输出必须符合 `schema.json`，候选 Markdown 不得与结构化摘要矛盾。

## 五不清单（核心边界）

见 `references/stage-rules.json` 的 `writingPrinciples.fiveNots`：
1. **不写技术实现**：不提及具体技术栈、架构模式、API 接口、代码片段、配置参数
2. **不写设计参数**：不定义色号、像素、字体，使用功能性描述
3. **不写 Skill/代码层内容**：不提及 Skill 名称或实现方式
4. **不写废话**：避免营销话术，多用要点和表格
5. **不设限**：不人为限制 PRD 结构的创造力
