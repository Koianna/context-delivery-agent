# PRD 分阶段规则

> **配置文件**：业务规则的单一事实来源在 `stage-rules.json`，本文档为人类可读版本。

经 CP-R01 批准返回 `PRD_DRAFTING_CORE` 或 `PRD_DRAFTING_DETAILS` 时，允许基于快照中的 `approved_prd_base_version` 创建修订版本。只修改影响报告列出的章节，其他章节保持不变；CP-R01 不能替代修订后的独立审核和 CP-P03。

## CORE 必需章节

见 `stage-rules.json` 的 `stages.CORE.requiredSections`：

- 背景与问题
- 产品目标与非目标
- 目标用户与场景
- 本期范围与明确不做
- 核心用户流程
- 已确认决策
- 待确认信息

CORE 不要求完整功能规则、异常分支、权限和验收矩阵。

## CORE 禁止内容

见 `stage-rules.json` 的 `stages.CORE.forbiddenSections`：

- 验收标准
- 角色与权限
- 功能规则
- 边界与异常

## CORE 关键检查点

见 `stage-rules.json` 的 `stages.CORE.checkpoints`：

- 功能范围是否明确
- 核心流程是否完整
- 功能逻辑是否清晰

## DETAILS 必需章节

见 `stage-rules.json` 的 `stages.DETAILS.requiredSections`：

在 CORE 基础上增加：

- 功能规则与状态
- 角色和权限
- 边界与异常处理
- 上下游依赖
- 验收标准
- 数据与效果验证
- 发布前待办

## 事实纪律

见 `stage-rules.json` 的 `factDiscipline`：

- 稳定 Context 可作为事实，但仍需检查版本和适用范围。
- 人工确认决策可作为需求规则。
- workspace 中未确认内容必须显式标注待确认。
- 不得用”行业常见做法”补齐缺失业务规则。
