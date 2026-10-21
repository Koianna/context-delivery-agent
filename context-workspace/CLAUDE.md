# Context Workspace

> 项目材料工作区 - 三层生命周期管理

## Directory Structure

| Directory | Purpose | Layer |
|-----------|---------|-------|
| `context/` | 已确认的知识 | 高可信度 |
| `workspace/` | 进行中的工作 | 中可信度 |
| `drafts/` | 正在形成的想法 | 低可信度 |

## Lifecycle

```
drafts/      → 原始材料、初步想法
  ↓ 人工确认
workspace/   → 正在进行的任务、PRD
  ↓ CP-C01 确认
context/     → 已验证的稳定知识
```

## Current Projects

- **default-project** — [drafts](drafts/default-project/CLAUDE.md)

## Rules

- **不自动提升**：层级提升需要人工确认
- **When in doubt, drafts**：不确定时放 drafts
- **索引必须同步**：文件增删后更新索引
- **原文保留**：原始材料归档在 `.source-materials/`

## How to Use

- 当 AI 需要了解产品业务时 → 读 `context/`
- 当 AI 需要了解正在做什么时 → 读 `workspace/`
- 当提供新材料时 → 先放 `drafts/`，确认后提升
