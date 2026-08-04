# change-impact

> 版本：0.1.0
> 模式：ANALYZE, REPLAN

## 职责

分析需求变化影响范围并生成重规划建议

## 触发条件

见 `AGENTS.md` 中的 Skill 路由表。

## 输入

见 `schemas/` 目录中对应契约。

## 输出

结构化 JSON，见输入输出契约文档。

## 权限

本 Skill 只能通过主 Agent 经 Harness 调用，不能直接修改全局状态或稳定 Context。
