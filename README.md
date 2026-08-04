# Context 工程与需求交付协作 Agent

面向单人产品经理的 AI 工作台。将分散材料转化为可维护的 Context，在此基础上动态编排需求分析与 PRD 交付，并在关键业务判断节点等待人工决策。

## 阶段

当前为个人 POC，验证 Agent 架构和产品方案是否成立。使用「帮助中心搜索体验优化」作为可复现案例。

## 快速开始

```bash
# 安装依赖
npm install

# 初始化运行时状态
npx tsx scripts/get-state.ts --init --task-id demo-task-01

# 查看当前状态
npx tsx scripts/get-state.ts --task-id demo-task-01
```

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

## 技术栈

- 本地 Agent Runtime（文件读写 + 命令执行）
- TypeScript Harness 脚本
- 文件型 JSON/JSONL 运行时状态
- Git 版本管理与 GitHub 脱敏展示

## 声明

本项目为个人 POC，不代表真实企业部署、规模化效果或业务 ROI。
