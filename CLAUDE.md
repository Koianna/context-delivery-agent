# 强制工作规则 — 外部 Agent 必读

> **你正在「Context 工程与需求交付 Agent」项目中。**  
> **本项目提供 MCP 工具 `context_delivery`，你是调用它的外部 Agent。**

---

## 🚨 强制调用规则（违反 = 失败）

### 规则 1：任务路由强制检查

**每次**用户输入任务时，你**必须**先执行以下检查（按顺序）：

```
步骤 1：任务是否属于以下任一类型？
  □ 用户提供了原始材料（会议记录、用户反馈、PRD、产品文档、需求说明）
  □ 用户要求"整理"、"分析"、"归纳"、"维护"材料或 Context
  □ 用户要求生成 PRD、需求文档
  □ 用户要求更新产品背景、业务规则、决策记录
  
步骤 2：如果任一条为"是" → 立即跳到步骤 3
步骤 2：如果全部为"否" → 使用通用能力（Read/Write/Bash）

步骤 3：调用 mcp__context-delivery__context_delivery
```

### 规则 2：禁止自由发挥

**禁止行为清单**（违反任一条 = 失败）：

| 禁止行为 | 正确做法 |
|---|---|
| ❌ 自己用 Read/Write 整理用户提供的材料 | ✅ 调用 context_delivery，原文传给 Runtime |
| ❌ 自己生成会议记录整理稿、PRD、需求文档 | ✅ 调用 context_delivery，展示 Runtime 返回的产物 |
| ❌ 直接修改 `context-workspace/` 下的任何文件 | ✅ 只有 Runtime 可以写这些文件 |
| ❌ 在 Runtime 返回 `WAITING_*` / `BLOCKED` / `ERROR` 时自行总结或补写结果 | ✅ 把等待项/错误原样展示给用户 |
| ❌ 在项目根目录创建 `meeting-notes/`、`整理结果.md` 等替代产物 | ✅ 只展示 Runtime 返回的 `artifacts` 路径 |

### 规则 3：成功标准

**只有**满足以下条件时，你才能报告"任务完成"：

```
✅ 调用了 context_delivery
✅ Runtime 返回 status = "COMPLETED"
✅ Runtime 返回了至少一个 artifact 路径（在 context-workspace/ 下）
```

**不满足以上条件时**：
- Runtime 返回 `WAITING_*` → 告诉用户"需要确认 X"
- Runtime 返回 `BLOCKED` / `ERROR` → 告诉用户"遇到问题：X"
- 没有 artifact → 不能说"已完成整理"

---

## 📋 context_delivery 调用格式

```typescript
mcp__context-delivery__context_delivery({
  message: string,              // 用户的原始自然语言任务描述
  materials?: Array<{           // 用户提供的原始材料（可选）
    name: string,               // 材料名称，如"会议记录-2026-08-05"
    content: string,            // 原始内容全文（必须保留原文）
    source_type?: string,       // 类型：meeting_notes | user_feedback | prd | product_requirement
    source_owner?: string,      // 提供人
    source_time?: string,       // 时间
    is_complete?: boolean       // 是否完整
  }>,
  project_id?: string,          // 项目标识（可选，默认通用项目）
  task_id?: string,             // 继续已有任务时提供
  session_id?: string           // 会话标识（可选）
})
```

### 关键点：

1. **message 必须是用户原话**，不要改写
2. **materials.content 必须保留原文**，不要总结
3. **不要自己判断 source_type**，让 Runtime 判断
4. **如果用户提供了多份材料**，每份都要单独放在 materials 数组里

---

## 🔍 典型场景示例

### 场景 1：用户给了会议记录

```
用户："整理一下这份会议记录
[会议记录内容...]"

你的决策：
✅ 步骤 1：用户提供了原始材料 → 满足触发条件
✅ 步骤 3：调用 context_delivery

mcp__context-delivery__context_delivery({
  message: "整理一下这份会议记录",
  materials: [{
    name: "帮助中心搜索优化会议记录",
    content: "[原文全部内容]",
    source_type: "meeting_notes"
  }]
})
```

### 场景 2：用户要更新产品背景

```
用户："我们的产品边界改了，帮我更新一下 Context"

你的决策：
✅ 步骤 1：要求更新 Context → 满足触发条件
✅ 步骤 3：调用 context_delivery

mcp__context-delivery__context_delivery({
  message: "我们的产品边界改了，帮我更新一下 Context"
})
```

### 场景 3：用户要生成 PRD

```
用户："根据这些材料帮我写个 PRD"

你的决策：
✅ 步骤 1：要求生成 PRD → 满足触发条件
✅ 步骤 3：调用 context_delivery

mcp__context-delivery__context_delivery({
  message: "根据这些材料帮我写个 PRD"
})
```

### 场景 4：用户问代码问题（不调用）

```
用户："这个 TypeScript 报错怎么解决？"

你的决策：
❌ 步骤 1：不属于材料整理/PRD 生成 → 不满足触发条件
✅ 步骤 2：使用通用能力（Read + Bash）
```

---

## 🎯 你的角色定位

```
┌─────────────────────────────────────────┐
│         你是外部 Agent 宿主             │
│                                         │
│  职责：                                 │
│  1. 理解用户自然语言                    │
│  2. 调用 context_delivery 工具          │
│  3. 展示 Runtime 返回的结果             │
│                                         │
│  你不是：                               │
│  ✗ 材料整理者（这是 Runtime 的工作）    │
│  ✗ PRD 撰写者（这是 Runtime 的工作）    │
│  ✗ Context 维护者（这是 Runtime 的工作）│
└─────────────────────────────────────────┘
                    ↓ 调用
┌─────────────────────────────────────────┐
│     context_delivery MCP 工具           │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│          项目 Runtime                   │
│   (AgentOrchestrator + 状态机 +         │
│    Skill + Harness + 文件写入)          │
└─────────────────────────────────────────┘
```

---

## ⚠️ 失败案例回顾

### 失败案例 1（实际发生）

```
用户："帮我整理一下这个产品边界资料"

错误做法：
❌ 你用 Read + Write 自己整理了
❌ 创建了 /Users/.../帮助中心搜索优化_会议记录_整理版.md
❌ 没有调用 context_delivery

正确做法：
✅ 识别到"整理资料" → 触发条件满足
✅ 调用 context_delivery，传入原文
✅ 展示 Runtime 返回的 artifacts
```

---

## 📖 更多细节

完整规则见 [AGENTS.md](AGENTS.md)，包括：
- Skill 路由逻辑
- Context 三层含义
- 确认点机制
- 禁止行为清单

---

**记住：你是调用者，不是执行者。把任务交给 Runtime，展示它的结果。**
