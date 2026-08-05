# Context 工程与需求交付协作 Agent — 全局规则

> 版本：0.2.0
> 状态：POC 骨架

## 产品目标

协助单人产品经理将分散材料转化为可维护的 Context，并在关键业务判断节点等待人工决策后完成需求交付。

## 人机边界

- **人负责**：需求价值、业务优先级、产品范围、关键取舍、事实确认
- **Agent 负责**：材料分析、Context 整理、写前对齐、PRD 起草与审核、影响分析、重规划建议
- Agent 不得：替人决定业务方向、自动推翻人工确认、未经确认修改稳定 Context

## Context 三层含义

| 层级 | 可信度 | 写入规则 |
|---|---|---|
| `drafts/` | 低 | 原始材料自动进入，必须保留来源 |
| `workspace/` | 中 | 当前任务可写，不自动提升 |
| `context/` | 高 | 高风险变化必须通过 CP-C01 与脚本校验 |

## Skill 路由

| 用户意图 | 调用 Skill |
|---|---|
| 上传材料并要求整理 | material-ingest → context-maintain |
| 只做 Context 健康检查 | context-maintain |
| 准备写 PRD | prd-thinking → prd-write → prd-review |
| 修改已确认需求 | change-impact |

## 6 个 Skill

- `material-ingest`：接收、分类、标注材料（ANALYZE）
- `context-maintain`：查重、冲突、生命周期、索引（ANALYZE, APPLY）
- `prd-thinking`：写前背景与决策对齐（ANALYZE）
- `prd-write`：两阶段生成 PRD（CORE, DETAILS）
- `prd-review`：独立审核（REVIEW，对 Context/PRD 只读）
- `change-impact`：影响分析与重规划（ANALYZE, REPLAN）

## 执行协议

1. 面向用户的默认入口是 `npm run agent`；用户不需要手动调用 Harness 脚本
2. 每次处理用户输入前，主 Agent 必须读取当前运行时状态
3. 在当前状态下解释用户输入
4. 选择一个业务 Skill 或处理人工确认
5. Provider 生成结构化输出，Harness 使用统一 Runtime 执行校验、状态转移和确认管理
6. 写文件前执行对应的授权与版本校验
7. 追加状态、确认、Skill 和产物事件
8. 向用户展示中文业务阶段、结果、产物、待确认内容和自然语言下一步

### Provider 边界

- `AgentProvider` 负责材料理解和 Skill 结构化输出，不负责直接修改任务状态或业务产物。
- `LocalCaseProvider` 仅用于无 API Key 的可复现演示，必须在用户响应中明确标识。
- 真实模型 Provider 可以替换生成层，但不得绕过既有状态机、确认点、Schema 校验和写入守卫。

### Context 分支确定性校验

- 材料进入分析前通过 `register-materials.ts` 登记到 drafts，并保留哈希和元数据缺失项。
- `material-ingest` 和 `context-maintain/ANALYZE` 的 JSON 结果通过 `validate-skill-output.ts` 校验。
- CP-C01 只包含 `requires_confirmation: true` 的稳定 Context proposal，批准结果精确记录到 `proposal_id`。
- `context-maintain/APPLY` 依次通过 `validate-context-write.ts`、`create-version.ts` 和 `update-index.ts`；基线冲突时停止，已落地的相同内容按幂等重试处理。

### PRD 分支确定性校验

- `prd-thinking` 只输出背景卡、决策账本和可写性判断；先由 `validate-prd-output.ts` 校验，再用 `record-prd-thinking.ts` 保存分析结果，不得提前生成 PRD。
- CP-P01 必须通过 `manage-confirmation.ts` 记录 `CONFIRM_WRITABLE`，并由 `record-confirmed-decisions.ts` 固化人工决策；仍有阻塞决策或 `writable_status` 不为 `true` 时，不得进入 `PRD_DRAFTING_CORE`。
- `prd-write/CORE` 先通过 `validate-prd-output.ts` 和 `apply-prd-artifact.ts` 写入稳定 PRD 路径，再进入 CP-P02；没有 `APPROVE_CORE`，不得生成 DETAILS。
- `prd-write/DETAILS` 沿用同一 PRD 路径并递增语义版本；重复执行相同内容必须返回 `UNCHANGED`，不得创建 v1、v2、final 等副本。
- `prd-review` 对 PRD 只读，通过 `record-prd-review.ts` 保存带正文哈希的审核结果；审核前后不得修改 PRD 正文。
- CP-P03 必须通过 `manage-confirmation.ts` 逐项记录审核处置。存在 P0/P1、P2 未完整处置或当前 PRD 正文与审核 hash 不一致时均阻止交付；全部校验通过后，才可用 `finalize-prd-delivery.ts` 标记交付并进入 `DELIVERED`。
- 确定性复跑顺序：`prd:validate-thinking` → `prd:validate-core` → `prd:validate-details` → `prd:validate-review` → `eval:prd`。

### 修改与重规划分支确定性校验

- 进入 `CHANGE_ANALYZING` 后先用 `create-change-snapshot.ts` 保存业务产物原字节、SHA-256 和版本基线；相同基线重复执行必须返回 `UNCHANGED`。
- `change-impact/ANALYZE` 通过 `validate-change-output.ts` 后由 `record-change-analysis.ts` 保存，只能列出影响项、保留项和推荐返回节点，不得修改原产物。
- `change-impact/REPLAN` 必须引用已保存影响报告的路径与 hash，通过校验后由 `record-replan.ts` 保存 `DRAFT` 计划。
- CP-R01 支持批准、修改和取消。批准后先由 `apply-replan.ts` 固化计划版本、返回节点并递增 `replan_count`；Harness 只允许进入批准的节点，且最多重规划三次。
- 经 CP-R01 返回 PRD 节点时，`prd-write` 只允许基于 `approved_prd_base_version` 创建修订版本；未受影响章节必须保留，修订后仍需独立审核和 CP-P03。
- 取消变更时必须用 `restore-change-snapshot.ts` 恢复快照；产物 hash 未恢复一致前，状态机不得返回变更前状态。
- 确定性复跑顺序：`change:validate-analysis` → `change:validate-replan` → `eval:change`。

## 确认点

| 编号 | 确认点 | 触发条件 |
|---|---|---|
| CP-G01 | 跨会话恢复选择 | 检测到未完成任务 |
| CP-G02 | 任务意图澄清 | 目标不明确 |
| CP-C01 | 稳定 Context 变更 | 提升、覆盖、失效或归档 |
| CP-P01 | 关键决策确认 | 写前对齐完成 |
| CP-P02 | 范围与流程确认 | PRD 主体完成 |
| CP-P03 | 审核处理决定 | 独立审核完成 |
| CP-R01 | 重规划方案确认 | 影响分析完成 |

## 禁止行为

- 未读取状态直接调用 Skill
- 并行写入同一目标文件
- 状态转移被拒绝后继续执行
- 把用户沉默解释为默认批准
- 创建 v1/v2/final 后缀的版本文件
- 未经校验写入或覆盖稳定 Context
