# Context 工程与需求交付协作 Agent

面向单人产品经理的 AI 工作台。将分散材料转化为可维护的 Context，在此基础上动态编排需求分析与 PRD 交付，并在关键业务判断节点等待人工决策。

**架构边界：外部 Agent 是可替换的自然语言交互宿主，项目 Runtime 是唯一的业务编排与执行中心。** 外部 Agent 可以是 Claude、Codex、Cursor、Gemini 或其他兼容宿主，但不能直接修改业务文件、确认记录或 Runtime 状态。

## 阶段

当前为个人 POC，验证 Agent 架构和产品方案是否成立。使用「帮助中心搜索体验优化」作为可复现案例。

## 快速开始

```bash
# 安装依赖
npm install

# 启动通用 External Agent Gateway（JSONL）
npm run gateway
```

外部 Agent 向 Gateway 写入一行 JSON 请求，直接传递用户自然语言：

```json
{"protocol_version":"0.1","request_id":"req_demo_001","task_id":"demo-task","session_id":"session_demo","message":"只整理帮助中心搜索材料，不写 PRD","client":{"id":"my-agent","name":"可替换外部 Agent","version":"1.0.0"}}
```

Gateway 返回统一的 `agent_response`、Runtime 状态、产物、确认项和下一步。外部 Agent 只展示结果并将用户的确认原文再次发送，不能自行构造批准状态。

不接入外部宿主时，也可以使用参考 CLI 适配器，直接描述目标，不需要手动执行 Harness 脚本：

```text
你：只整理帮助中心搜索材料，不写 PRD
Agent：完成材料登记与分析，停在 CP-C01，请确认两条稳定 Context 更新建议

你：确认全部
Agent：执行获批更新，报告材料、Context 索引和遗留问题的位置

你：继续准备 PRD
Agent：先完成写前对齐，停在 CP-P01，不会直接生成 PRD
```

也可以从 VS Code 终端发起单轮请求：

```bash
npm run agent -- \
  --task-id demo-task-01 \
  --message "只整理帮助中心搜索材料，不写 PRD" \
  --material "$(pwd)/case-data/help-center-search/source-materials"
```

`npm run agent` 是参考 CLI 适配器，不是项目唯一入口，也不是业务编排中心。`state:*`、`context:*`、`prd:*`、`change:*` 命令仍作为后台 Harness 与回归工具保留，不要求日常用户直接操作。Gateway 协议定义见 [`schemas/external-agent-gateway.schema.json`](schemas/external-agent-gateway.schema.json)。

当前 Runtime 使用“本地可复现 Provider”：它读取帮助中心搜索案例的已校验结构化输出，让演示不依赖 API Key；材料登记、状态转移、人工确认、版本校验和产物写入仍由 Runtime 与 Harness 执行。响应会明确展示 Provider 类型，不把固定案例输出表述为实时模型生成。

## Runtime 业务编排中心

`AgentOrchestrator` 每轮先读取运行时状态，再完成以下编排：

1. 从自然语言识别“材料整理、PRD 交付、修改与重规划、继续任务”。
2. 调用 Provider 获取结构化 Skill 输出，并使用既有校验器检查。
3. 通过统一 Runtime 执行状态转移、创建和解析确认记录。
4. 在 CP-C01、CP-P01、CP-P02、CP-P03、CP-R01 自动暂停。
5. 将用户自然语言确认映射为当前节点允许的动作，不接受沉默或模糊表达作为批准。
6. 返回业务阶段、产物位置、需要判断的事项和可回复内容；英文状态仅在 `--debug` 时显示。

交互层支持：

- **Context**：材料登记 → 分析 → CP-C01 → 稳定 Context 更新或暂缓
- **PRD**：写前对齐 → CP-P01 → CORE → CP-P02 → DETAILS → 审核 → CP-P03 → 交付
- **Change**：快照 → 影响分析 → 重规划 → CP-R01 → 返回最小修订节点
- **任务控制**：暂停、继续、取消和模糊意图澄清

POC 当前限制：单用户、单任务运行时；只内置帮助中心搜索案例 Provider；CP-R01 批准后返回修订节点，但不会在缺少新业务输入时自动覆盖已交付 PRD。接入真实模型时只需实现 `AgentProvider`，状态机和 Harness 不变。

## 后台验证

```bash
# 主 Agent 自然语言完整链路
npm run eval:agent

# 外部 Agent 宿主替换与 Gateway 协议
npm run eval:gateway

# 查看当前状态
npx tsx scripts/get-state.ts --task-id demo-task-01
```

`npm run eval:agent` 隔离验证 12 个断言，包括自然语言路由、五个核心确认点、确认前禁止写入、PRD 分阶段交付、Change 最小返回节点和产物可追溯性。
`npm run eval:gateway` 验证两个不同宿主通过同一 `task_id` 交接任务、保留 Runtime 产物，以及非法协议输入不改变业务状态。

## 阶段 3：Context 分支

帮助中心搜索案例包含产品现状、用户反馈、当前讨论结论和历史需求边界四类材料。可用以下命令验证材料登记、两个 Skill 的结构化结果和 Context 控制规则：

```bash
npm run context:register
npm run skills:validate
npm run context:validate-material
npm run context:validate-analysis
npm run eval:context
```

`npm run eval:context` 在临时目录内验证 11 个断言，不修改稳定 Context。完整演示产物位于 `context-workspace/`：原始材料保存在 drafts，分析与未决问题保存在 workspace，只有经过 CP-C01 逐项批准的内容进入 context。

## 阶段 4：PRD 分支

PRD 分支基于已确认的 Context 工作，以“写前判断 → 主体 → 细节 → 独立审核”三段 Skill 协作完成交付，并在 CP-P01、CP-P02、CP-P03 保留人工决策权。可依次执行：

```bash
npm run skills:validate
npm run prd:validate-thinking
npm run prd:validate-core
npm run prd:validate-details
npm run prd:validate-review
npm run eval:prd
```

`npm run eval:prd` 在临时目录内执行 12 个断言，覆盖写前阻塞、确认门禁、CORE/DETAILS 分阶段生成、稳定路径与连续版本、幂等写入、只读审核，以及审核后正文漂移等交付阻断。案例输入与预期结果位于 `case-data/help-center-search/prd/`，完整演示产物位于：

- `context-workspace/workspace/reports/prd-thinking.json`：写前背景、决策和可写性分析
- `context-workspace/workspace/decisions/decision-ledger.json`：经 CP-P01 确认的决策账本
- `context-workspace/workspace/prd/help-center-search.md`：从 CORE `0.1.0` 演进到 DETAILS `0.2.0` 的稳定 PRD
- `context-workspace/workspace/reports/prd-review.json`：带 PRD 正文哈希的独立审核结果
- `evaluation/execution-logs/prd-branch-demo.json`：状态路径、确认点和交付结果

## 阶段 5：修改与重规划分支

Change 分支处理已有 Context、决策或 PRD 的实质变化。Agent 先保存不可变快照，再区分受影响和保留内容，生成最小重跑计划；CP-R01 批准前不覆盖业务产物。

```bash
npm run skills:validate
npm run change:validate-analysis
npm run change:validate-replan
npm run eval:change
```

`npm run eval:change` 在临时目录内执行 12 个断言，覆盖快照幂等、影响与保留范围、零改写分析、最小返回节点、CP-R01 门禁、重规划上限、`0.2.1` 局部修订和取消恢复。完整演示产物位于：

- `context-workspace/workspace/snapshots/change-target-unavailable-001/`：六个业务产物的原始快照与 hash 清单
- `context-workspace/workspace/reports/change-impact.json`：规则变更影响报告
- `context-workspace/workspace/plans/help-center-search-replan.json`：CP-R01 批准的最小重跑计划
- `evaluation/execution-logs/change-branch-demo.json`：状态路径、错误节点阻断和 PRD 完整性证据

## 目录结构

| 目录 | 用途 |
|---|---|
| `docs/` | 产品定义、用户流程、状态机、契约、架构文档 |
| `AGENTS.md` | 全局规则、Context 加载、Skill 路由与确认规则 |
| `prompts/` | 主 Agent 与 Skill Prompt |
| `skills/` | 6 个原生 Skill：material-ingest、context-maintain、prd-thinking、prd-write、prd-review、change-impact |
| `context-workspace/` | 三层文件型 Context 仓库（drafts → workspace → context） |
| `runtime/` | 即时任务状态（不提交 Git） |
| `state-machine/` | 22 个状态、合法转移表与守卫条件配置 |
| `schemas/` | JSON Schema 定义 |
| `scripts/` | TypeScript Harness：状态转移、确认管理、写入校验、版本与索引 |
| `case-data/` | 帮助中心搜索体验优化完整案例 |
| `evaluation/` | 测试用例、评分标准、执行日志与 Bad Case |

## 三条演示路径

1. **只整理 Context**：上传材料 → 分析 → 确认 → 维护 → 完成
2. **Context → PRD 完整交付**：写前对齐 → 确认 → 主体生成 → 确认 → 细节补充 → 审核 → 交付
3. **修改与重规划**：变更输入 → 影响分析 → 新计划 → 确认 → 返回节点

## 架构分层

```text
产品经理 → 外部 Agent 宿主 → External Agent Gateway → AgentOrchestrator
                                                     ↓
                                  状态机 / Skills / Harness / Context / Runtime
```

- 外部 Agent：自然语言理解、追问、确认收集和结果展示。
- Gateway：协议适配、请求校验和响应包装。
- Runtime：唯一的路由、状态转移、Skill 编排、人工确认、受控写入、版本和日志执行中心。

## 技术栈

- TypeScript Runtime 与可替换 External Agent Gateway
- TypeScript Harness 脚本
- 文件型 JSON/JSONL 运行时状态
- Git 版本管理与 GitHub 脱敏展示

## 声明

本项目为个人 POC，不代表真实企业部署、规模化效果或业务 ROI。
