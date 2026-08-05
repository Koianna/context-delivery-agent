# Runtime 响应格式规范

> 版本：0.1.0

Runtime 对外统一返回 `AgentResponse`。Gateway 在外层增加 `request_id`、协议版本、Runtime 摘要和错误包装。外部 Agent 可以自由选择展示形式，但必须保留状态、确认要求、产物引用和下一步。

## 结构化输出要求

Agent 响应中涉及业务数据时必须返回结构化 JSON，面向用户的 Markdown 由展示层渲染。

## 来源引用规则

每条事实、决策、冲突和审核问题必须关联：
- `source_id`
- `source_type`
- `location`
- `source_time`
- `quote`

没有来源的信息只能标记为推测、建议或待确认。

## 决策理由规则

所有路由和建议必须返回简洁、可核验的 `reason`，说明引用了什么事实和规则。
