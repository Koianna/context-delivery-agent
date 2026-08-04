---
name: context-maintain
description: 分析并维护文件型 Context，识别重复、冲突、过期内容、术语和索引问题，生成可逐项确认的更新建议，并仅在 CP-C01 批准后执行稳定 Context 写入。用户要求整理材料后的 Context 建议、Context 健康检查或应用已批准变更时使用；不用于生成 PRD。
---

# Context Maintain

## 模式

### ANALYZE

1. 读取 `material-ingest` 结果、当前 workspace 和最小必要的稳定 Context。
2. 按 `references/maintenance-rules.md` 检查重复、冲突、时效、术语、索引和引用。
3. 将建议拆成可独立批准的 proposal；每项说明应用与忽略的影响。
4. 稳定 Context 动作必须关联已确认信息、设置 `requires_confirmation: true` 并进入 CP-C01。
5. 只返回 `schema.json` 的 `ANALYZE` 结构，不执行写入。

### APPLY

1. 只接收 CP-C01 明确批准的 proposal。
2. 通过 `scripts/validate-context-write.ts` 校验任务状态、目标路径、基线版本、来源和逐项授权。
3. 通过 `scripts/create-version.ts` 写入，通过 `scripts/update-index.ts` 更新索引。
4. 基线冲突或授权缺失时停止，不部分覆盖同一 proposal。
5. 返回 `schema.json` 的 `APPLY` 结构。

## 边界

- `ANALYZE` 不能修改稳定 Context。
- 未确认的观察和提案只能进入 drafts/workspace。
- `APPLY` 不能扩大批准范围，也不能把用户沉默当作批准。
- 业务优先级、方案价值和范围取舍仍由人决定。

## 资源

- 维护规则：`references/maintenance-rules.md`
- 输出契约：`schema.json`
- 提示模板：`prompt.md`
- 最小示例：`examples/minimal-analysis.json`
