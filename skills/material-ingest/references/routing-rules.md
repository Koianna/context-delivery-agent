# 层级路由规则

> 版本：2.0.0  
> 更新：2026-08-25  
> 用途：定义材料应该路由到哪个层级（drafts/workspace/context）

---

## 一、三层模型

```
drafts/      → 低可信度，正在形成的想法
  ↓ 人工确认 或 智能路由
workspace/   → 中可信度，正在进行的工作
  ↓ CP-C01 确认
context/     → 高可信度，已确认的知识
```

**核心原则**：
- **不自动提升**：层级提升需要人工判断
- **When in doubt, drafts**：不确定时默认放 drafts
- **错误代价不对称**：放错到 context 比放错到 drafts 危害更大

---

## 二、路由规则（按优先级排序）

### 规则格式

```yaml
规则名称:
  - 优先级: 数字（越小越优先）
  - 条件: [判断条件列表]
  - 目标层级: drafts | workspace | context
  - 需要确认: true | false
  - 理由: 说明文字
```

---

### 规则 1：明确标记为"已确认" → context

**优先级**: 1  
**目标层级**: context  
**需要确认**: true（高风险，必须人工确认）

**触发条件**（任一满足）：
- task_goal 包含: "已确认", "confirmed", "verified", "approved", "稳定知识"
- material.name 包含: "已确认", "confirmed", "verified"
- material.source_type 包含: "CONFIRMED"

**理由**: 材料明确标记为已确认的知识

**示例**：
```
✅ task_goal: "整理已确认的产品定位"
✅ material.name: "产品定位-已确认版本.md"
✅ source_type: "CONFIRMED_DOCUMENT"
```

---

### 规则 2：有明确所有者和时间线 → workspace

**优先级**: 2  
**目标层级**: workspace  
**需要确认**: false

**触发条件**（任一满足）：

**所有者相关**：
- task_goal 包含: "负责人:", "owner:", "@某人负责", "某人负责"
- material.source_owner 字段非空且长度 > 0

**时间线相关**：
- task_goal 包含: "截止:", "deadline:", "Q1", "Q2", "Q3", "Q4", "本季度", "下季度", "本月", "下月", "本周", "下周"
- task_goal 包含日期格式: YYYY-MM-DD, YYYY/MM/DD, MM月DD日

**理由**: 有明确所有者和时间线的工作任务

**示例**：
```
✅ task_goal: "新功能开发，张三负责"
✅ task_goal: "需求整理，截止本月底"
✅ task_goal: "Q2 规划材料"
✅ material.source_owner: "李四"
```

---

### 规则 3：PRD 且处于活跃状态 → workspace

**优先级**: 3  
**目标层级**: workspace  
**需要确认**: false

**触发条件**（同时满足）：
1. 内容类型 = PRODUCT_REQUIREMENT
2. task_goal 或 material.name 包含活跃状态关键词

**活跃状态关键词**：
- 中文: "进行中", "开发中", "设计中", "待开发", "规划中"
- 英文: "in-progress", "wip", "active", "ongoing", "in-development"

**理由**: PRD 或产品需求，且处于活跃状态

**示例**：
```
✅ 内容类型: PRODUCT_REQUIREMENT + task_goal: "新功能 PRD - 进行中"
✅ 内容类型: PRODUCT_REQUIREMENT + material.name: "用户系统-开发中.md"
```

---

### 规则 4：会议记录 → drafts

**优先级**: 4  
**目标层级**: drafts  
**需要确认**: false

**触发条件**：
- 内容类型 = MEETING_NOTE

**理由**: 会议记录属于原始材料

**示例**：
```
✅ 内容类型: MEETING_NOTE
```

---

### 规则 5：用户反馈 → drafts

**优先级**: 5  
**目标层级**: drafts  
**需要确认**: false

**触发条件**：
- 内容类型 = USER_FEEDBACK

**理由**: 用户反馈需要验证后提升

**示例**：
```
✅ 内容类型: USER_FEEDBACK
```

---

### 规则 6：决策记录 → drafts

**优先级**: 6  
**目标层级**: drafts  
**需要确认**: false

**触发条件**：
- 内容类型 = DECISION_RECORD

**理由**: 决策记录待确认后可提升到 workspace

**示例**：
```
✅ 内容类型: DECISION_RECORD
```

---

### 规则 99：默认规则 → drafts

**优先级**: 99  
**目标层级**: drafts  
**需要确认**: false

**触发条件**：
- 无法匹配以上任何规则

**理由**: 不确定时默认放 drafts（安全策略）

---

## 三、匹配逻辑

### 匹配流程

1. **按优先级顺序检查规则**
   - 从优先级 1 开始
   - 检查每条规则的触发条件
   - 第一个匹配的规则生效

2. **条件判断**
   - 文本匹配：不区分大小写
   - 字段检查：source_owner 非空
   - 日期格式：正则匹配

3. **返回结果**
   ```typescript
   {
     layer: 'drafts' | 'workspace' | 'context',
     confidence: 'high' | 'medium',
     reason: '匹配的规则说明',
     requiresConfirmation: boolean
   }
   ```

---

## 四、启用与配置

### 默认模式（保守）

```typescript
routing: {
  enable_smart_routing: false,  // 不启用智能路由
  default_layer: 'drafts'       // 所有材料到 drafts
}
```

**行为**：
- 所有材料固定路由到 drafts
- 人工确认后提升到 workspace 或 context

---

### 智能路由模式

```typescript
routing: {
  enable_smart_routing: true,   // 启用智能路由
  default_layer: 'drafts',
  require_context_confirmation: true  // context 层需确认
}
```

**行为**：
- 按规则自动路由
- 路由到 context 时需要人工确认
- 其他层级自动路由

---

## 五、使用说明

### 添加新规则

在"二、路由规则"中添加新规则：

```markdown
### 规则 X：描述 → 目标层级

**优先级**: X
**目标层级**: drafts | workspace | context
**需要确认**: true | false

**触发条件**：
- 条件 1
- 条件 2

**理由**: 说明

**示例**：
- ✅ 示例 1
- ✅ 示例 2
```

**注意事项**：
- 优先级数字越小，越优先匹配
- 新规则插入到合适的优先级位置
- 更新匹配逻辑说明

---

### 修改现有规则

**修改触发条件**：
找到对应规则，修改"触发条件"部分

**修改目标层级**：
找到对应规则，修改"目标层级"

**修改优先级**：
修改"优先级"数字，调整匹配顺序

---

### 示例：添加"技术规格到 workspace"规则

```markdown
### 规则 7：技术规格 → workspace

**优先级**: 7
**目标层级**: workspace
**需要确认**: false

**触发条件**：
- 内容类型 = TECHNICAL_SPEC
- task_goal 包含: "架构设计", "技术方案"

**理由**: 技术规格文档需要团队协作

**示例**：
- ✅ 内容类型: TECHNICAL_SPEC
- ✅ task_goal: "API 架构设计文档"
```

---

## 六、特殊场景处理

### 场景 1：材料同时满足多个规则

**处理方式**：选择优先级最高的规则（数字最小）

**示例**：
```
材料 A:
  - 满足规则 2（有所有者）→ workspace
  - 满足规则 4（会议记录）→ drafts
  
结果：选择规则 2（优先级更高）→ workspace
```

---

### 场景 2：路由到 context 被拒绝

**处理方式**：
1. 用户拒绝确认
2. 降级到 workspace
3. 记录原因

---

### 场景 3：规则冲突

**示例**：
```
规则 A: source_type = "MEETING" → drafts
规则 B: task_goal 包含 "已确认" → context

材料：source_type = "MEETING", task_goal = "已确认的会议纪要"
```

**解决方式**：按优先级，规则 B（优先级 1）优先

---

## 七、历史记录

### v2.0.0（2026-08-25）
- 新增完整的路由规则系统
- 定义 6 条主要规则 + 1 条默认规则
- 支持智能路由和默认模式
- 添加详细的使用说明

### v1.0.0（之前）
- 简单的层级说明
- 无具体路由规则

---

**文档版本**: 2.0.0  
**最后更新**: 2026-08-25  
**维护者**: AI Runtime Team
