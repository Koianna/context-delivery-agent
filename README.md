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
