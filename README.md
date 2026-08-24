# Context 工程与需求交付协作 Agent

面向单人产品经理的 AI 工作台。将分散材料转化为可维护的 Context，在此基础上动态编排需求分析与 PRD 交付，并在关键业务判断节点等待人工决策。

**架构边界：外部 Agent 是可替换的自然语言交互宿主，项目 Runtime 是唯一的业务编排与执行中心。** 外部 Agent 可以是 Claude、Codex、Cursor、Gemini 或其他兼容宿主，但不能直接修改业务文件、确认记录或 Runtime 状态。

---

## 📖 入口必读

**如果你是外部 Agent（Claude、Cursor、Codex 等）**，请先阅读 **[CLAUDE.md](CLAUDE.md)** — 强制工作规则与路由决策流程。

**核心要求**：
- ✅ 当用户提供材料（会议记录、用户反馈、PRD）或要求整理/生成 PRD/更新 Context 时，**必须调用** `mcp__context-delivery__context_delivery` 工具
- ❌ 禁止自己用 Read/Write 整理材料或生成 PRD
- ❌ 禁止直接修改 `context-workspace/` 下的任何文件
- ✅ 只展示 Runtime 返回的 `artifacts`，不自行创建替代产物

详细规则、触发条件清单和示例见 [CLAUDE.md](CLAUDE.md)。

---

## 阶段

当前为个人 POC，验证 Agent 架构和产品方案是否成立。默认面向真实日常工作材料。
## 快速开始

```bash
# 安装依赖
npm install

# 启动通用 External Agent Gateway（JSONL）
npm run gateway

# 启动 MCP stdio Server，供 Claude、Codex、Cursor 等外部 Agent 配置
npm run mcp
```

外部 Agent 向 Gateway 写入一行 JSON 请求，直接传递用户自然语言：

```json
{"protocol_version":"0.1","request_id":"req_demo_001","task_id":"demo-task","project_id":"product-work","session_id":"session_demo","message":"请整理这份会议记录，先不要写 PRD","client":{"id":"my-agent","name":"可替换外部 Agent","version":"1.0.0"},"materials":[{"name":"会议记录.md","content":"在这里粘贴本次真实会议记录原文","source_type":"MEETING_NOTE","is_complete":true}]}
```

Gateway 返回统一的 `agent_response`、Runtime 状态、产物、确认项和下一步。外部 Agent 只展示结果并将用户的确认原文再次发送，不能自行构造批准状态。

外部 Agent 的日常入口是 MCP 的 `context_delivery` 工具。工具支持直接传入 `materials[].content`，因此产品经理可以在外部 Agent 对话框粘贴会议记录，无需手动创建文件或执行 Skill 命令。MCP、JSONL Gateway 和 CLI 共享同一个 `AgentOrchestrator`，只有 Runtime 返回的结果才算项目执行结果。

外部 Agent 的 MCP 配置示例：

```json
{
  "mcpServers": {
    "context-delivery": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/绝对路径/Context 工程与需求交付 Agent"
    }
  }
}
```

连接后，宿主应调用 `context_delivery`。产品经理只需说“请整理这份会议记录，先不要写 PRD”并粘贴原文；宿主负责把原文放入 `materials`，Runtime 会执行 `material-ingest` 并返回真实状态。

### 日常项目使用

默认 Provider 是通用项目工作区。把会议记录、用户反馈、历史 PRD、产品现状和业务约束放在任意目录，通过 `project_id` 和 `material_path` 传入：

```json
{"protocol_version":"0.1","request_id":"req_phone_001","task_id":"account-task-001","project_id":"account-settings","message":"请收集整理这些用户反馈，保留原话和不确定性，不要直接写 PRD","material_path":"/Users/koi/Documents/account-materials","client":{"id":"my-agent"}}
```

例如材料中有“用户原话：手机号不用了”，Runtime 会保留原话并分类为用户反馈，询问这可能是修改手机号、解绑手机号还是其他诉求；在产品经理确认前，不会把它写成“用户要修改手机号”，也不会提升为稳定 Context。

通用工作区支持 Markdown、纯文本和 JSON 材料。原文只登记到 `context-workspace/drafts/<project_id>/source-materials/<task_id>/materials.md`，任务级元信息（`task_goal`、时间、整理稿指针）写在 bundle 顶部 YAML frontmatter，每条材料的属性写在 `<!-- context-material: ... -->` 头注释里，产品经理可直接阅读。项目级 `material-manifest.json` 作为派生缓存移至 `.cache/manifests/<project_id>/`（gitignore），缓存丢失时 Runtime 会从 bundle 自动重建。每个项目还会自动生成 `context-workspace/drafts/<project_id>/README.md`，展示材料时间线与整理稿链接。Runtime 分析记录保存在被 Git 忽略的 `.cache/agent-runs/`（通过 `runs://` ref 引用），可阅读整理稿发布到可版本管理的 `workspace/projects/<project_id>/materials/`。通用项目的稳定 Context 位于 `context-workspace/context/<project_id>/`。

不接入外部宿主时，也可以使用参考 CLI 适配器，直接描述目标，不需要手动执行 Harness 脚本：

```text
你：请整理这份会议记录，先不要写 PRD
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
  --message "请整理这份会议记录，先不要写 PRD" \
  --project product-work \
  --material "/path/to/your/materials"
```

`npm run agent` 是参考 CLI 适配器，不是项目唯一入口，也不是业务编排中心。`state:*`、`context:*`、`prd:*`、`change:*` 命令仍作为后台 Harness 与回归工具保留，不要求日常用户直接操作。Gateway 协议定义见 [`schemas/external-agent-gateway.schema.json`](schemas/external-agent-gateway.schema.json)。

当前 Runtime 默认使用“通用项目工作区 Provider”，负责材料接入、来源保留、保守分类和 Context 候选。明确的产品现状、已确认决策和业务约束会生成 Context 候选，必须经过 CP-C01 后才写入稳定 Context；用户反馈和模糊信息保留在 drafts/workspace。该 Provider 不具备真实模型写作能力，用户要求生成 PRD 时 Runtime 会在写前阻塞，不再生成或审核包含“待补充”的通用骨架。

### 启用真实模型

项目已提供可替换的真实模型 Provider。复制 `.env.example` 为 `.env`，然后按服务商配置：

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=你的 API Key
OPENAI_MODEL=你的账号可用模型 ID
```

配置后先检查，再重启 MCP、Gateway 或 CLI 进程：

```bash
npm run model:check
```

检查结果只显示 Provider、模型 ID、服务地址和 API Key 是否存在，不会输出密钥内容。只有检查通过的真实模型 Provider 才能进入 `prd-thinking → prd-write → prd-review`；配置缺失时任务进入可恢复阻塞，补齐配置并重启 Runtime 后可回复“重试”。

当前内置三类协议适配：OpenAI Responses API、DeepSeek/Kimi 等常见的 OpenAI 兼容 Chat Completions API，以及 Claude 的 Anthropic Messages API。DeepSeek 示例：

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的 DeepSeek Key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Kimi 使用 `MODEL_PROVIDER=kimi`、`KIMI_API_KEY`、`KIMI_MODEL` 和 `KIMI_BASE_URL`；Claude 使用 `MODEL_PROVIDER=claude`、`ANTHROPIC_API_KEY` 和 `CLAUDE_MODEL`。其他支持 OpenAI 兼容 Chat Completions 的服务使用 `MODEL_PROVIDER=compatible`、`MODEL_API_KEY`、`MODEL_ID`、`MODEL_BASE_URL`。模型名称和可用能力以服务商账号为准，`.env` 已被 Git 忽略，不要把密钥提交到仓库。

启用后，模型负责材料语义提取、结构化整理、PRD 候选和变更影响分析；所有厂商都必须通过统一的 `StructuredModelClient` 契约返回 JSON。每次模型调用前，`SkillRuntime` 会从 `skills/<skill_name>/` 动态加载 `SKILL.md`、`prompt.md`、`references/`、`schema.json` 和 `examples/`；修改这些文件会直接影响下一次真实模型生成。Runtime 仍负责本地 Schema 校验、状态转移、人工确认、版本检查和文件写入。模型不能直接修改稳定 Context 或跳过 CP-C01、CP-P01、CP-P02、CP-P03、CP-R01。发送给模型的内容包括当前任务所需的原始材料或业务产物，因此接入真实业务资料前应确认其符合组织的数据和隐私政策。

```bash
# 不访问真实 API 的模型接入回归测试
npm run eval:model
```

若密钥缺失、请求超时、API 返回错误、JSON 无法解析或模型输出未通过现有校验，Runtime 会停止本轮执行并进入可恢复阻塞，不会回退后静默写入业务产物。未设置真实模型 Provider 时，`WorkspaceProvider` 仍可整理材料和维护 Context，但不能生成 PRD。因此不能承诺“任意模型无条件可用”，但可以保证任何遵守该契约、能稳定输出所需 JSON 且通过本地校验的模型都不会破坏 Runtime 的控制边界；新增厂商只需新增协议客户端和 Provider 工厂路由。

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

POC 当前限制：单用户、单项目、单活跃任务运行时；本地 Provider 以保守规则和结构化基线为主，OpenAI Provider 的输出仍受同一套确定性校验约束；CP-R01 批准后返回修订节点，但不会在缺少新业务输入时自动覆盖已交付 PRD。更换 Provider 时状态机和 Harness 不变。

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

```bash
# 通用材料与项目隔离验证
npm run eval:workspace
```

`npm run eval:workspace` 使用隔离的通用测试材料验证：默认使用通用 Provider、保留原话、将具体诉求作为待确认问题，并按项目隔离产物。

## 阶段 3：Context 分支

Context 分支验证材料登记、两个 Skill 的结构化结果和 Context 控制规则。回归测试使用隔离的通用测试夹具，不作为日常工作材料：

```bash
npm run context:register
npm run skills:validate
npm run context:validate-material
npm run context:validate-analysis
npm run eval:context
```

`npm run eval:context` 在临时目录内验证 11 个断言，不修改稳定 Context。真实任务的原始材料保存在 drafts，分析与未决问题保存在 workspace，只有经过 CP-C01 逐项批准的内容进入 context。测试夹具位于 `evaluation/fixtures/`，不会被 Runtime 当作默认项目材料。

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

`npm run eval:prd` 在临时目录内执行 12 个断言，覆盖写前阻塞、确认门禁、CORE/DETAILS 分阶段生成、稳定路径与连续版本、幂等写入、只读审核，以及审核后正文漂移等交付阻断。测试输入与预期结果位于 `evaluation/fixtures/prd/`，完整回归产物位于：

- `context-workspace/workspace/reports/prd-thinking.json`：写前背景、决策和可写性分析
- `context-workspace/workspace/decisions/decision-ledger.json`：经 CP-P01 确认的决策账本
- `context-workspace/workspace/prd/<project_id>.md`：从 CORE `0.1.0` 演进到 DETAILS `0.2.0` 的稳定 PRD
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

`npm run eval:change` 在临时目录内执行 12 个断言，覆盖快照幂等、影响与保留范围、零改写分析、最小返回节点、CP-R01 门禁、重规划上限、`0.2.1` 局部修订和取消恢复。完整测试产物位于：

- `context-workspace/workspace/snapshots/change-target-unavailable-001/`：六个业务产物的原始快照与 hash 清单
- `context-workspace/workspace/reports/change-impact.json`：规则变更影响报告
- `context-workspace/workspace/plans/<project_id>-replan.json`：CP-R01 批准的最小重跑计划
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
| `evaluation/fixtures/` | 隔离的通用回归测试夹具，不作为产品案例 |
| `evaluation/` | 测试用例、评分标准、执行日志与 Bad Case |


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
