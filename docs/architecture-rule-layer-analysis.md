# 规则分层分析：代码层 vs Skills 层

## 当前规则分布现状

### 1. PRD Thinking 规则

| 规则内容 | 代码层位置 | Skills 层位置 | 重复？ |
|---------|-----------|--------------|-------|
| 不得输出 PRD artifact | `validate-prd-output.ts:11` | `prompt.md:14`（不输出 PRD 正文） | ✅ 重复 |
| 优先问题不超过 3 个 | `validate-prd-output.ts:12` | `prompt.md:13` | ✅ 重复 |
| 阻塞决策未确认时不能标记 READY | `validate-prd-output.ts:14-15` | `writable-rules.md:9`（所有阻塞决策已确认） | ✅ 重复 |
| decision_id 不能重复 | `validate-prd-output.ts:19` | ❌ 无 | ❌ 仅代码 |
| CONFIRMED 必须有 human_decision | `validate-prd-output.ts:21-23` | `prompt.md:10`（人工确认才能标 CONFIRMED） | ✅ 重复 |
| material_classification 必填 | `validate-prd-output.ts:26-28` | `schema.json:required` | ✅ 重复（schema 约束） |
| category/adoption 枚举合法性 | `validate-prd-output.ts:34-38` | `schema.json:enum` | ✅ 重复（schema 约束） |
| source_ref 必须在 materials_read/source_refs 中 | `validate-prd-output.ts:40-42` | ❌ 无 | ❌ 仅代码 |
| 反自洽：草稿不能 default_adopt | `validate-prd-output.ts:44-46` | `prompt.md:规则3`（新增） | ✅ 重复 |
| repo ref 格式合法性 | `validate-prd-output.ts:49-51` | ❌ 无 | ❌ 仅代码 |

### 2. PRD Write 规则

| 规则内容 | 代码层位置 | Skills 层位置 | 重复？ |
|---------|-----------|--------------|-------|
| PRD version 必须是语义版本 | `validate-prd-output.ts:62` | ❌ 无 | ❌ 仅代码 |
| 必需章节检查 | `validate-prd-output.ts:63-66` | `stage-rules.md:CORE/DETAILS 必需章节` | ✅ 重复 |
| PRD 引用了未确认决策 | `validate-prd-output.ts:68-69` | ❌ 无 | ❌ 仅代码 |
| PRD 存在 unsupported_claims | `validate-prd-output.ts:71` | `prompt.md:12`（发现输入冲突时输出 unresolved_items） | 部分重复 |
| CORE 不得提前展开 DETAILS 内容 | `validate-prd-output.ts:77-79` | `stage-rules.md:15`（CORE 不要求完整规则/权限/验收） | ✅ 重复 |
| DETAILS 必须包含特定章节 | `validate-prd-output.ts:80-84` | `stage-rules.md:19-27` | ✅ 重复 |
| **"五不"清单（不写技术/设计/代码）** | ❌ 无 | ❌ 无 | ❌ 两层都缺 |

### 3. PRD Review 规则

| 规则内容 | 代码层位置 | Skills 层位置 | 重复？ |
|---------|-----------|--------------|-------|
| PRD hash 必须一致（未修改正文） | `validate-prd-output.ts:98-99` | `SKILL.md:15`（审核后核对 hash） | ✅ 重复 |
| 审核版本与 PRD 版本一致 | `validate-prd-output.ts:100` | ❌ 无 | ❌ 仅代码 |
| P0/P1/P2 计数正确 | `validate-prd-output.ts:101-108` | ❌ 无 | ❌ 仅代码 |
| 问题必须有定位/描述/影响/建议 | `validate-prd-output.ts:110-112` | `prompt.md:11`（每个问题可定位+可执行建议） | ✅ 重复 |
| 存在 P0/P1 不能建议交付 | `validate-prd-output.ts:114-116` | `prompt.md:14`（P0/P1 存在时不得建议直接交付） | ✅ 重复 |
| **7 个审核维度** | ❌ 无 | `review-rubric.md:3-11` | ❌ 仅 skills |
| **减法审查/一致性审查** | ❌ 无 | ❌ 无（PRD skills.md 有，当前无） | ❌ 两层都缺 |

### 4. 确认点守卫（Confirmation Guards）

| 规则内容 | 代码层位置 | Skills 层位置 | 重复？ |
|---------|-----------|--------------|-------|
| CP-P01 必须确认可写状态 | `prd-guards.ts:15-28` | ❌ 无 | ❌ 仅代码 |
| CP-P02 必须确认范围和核心流程 | `prd-guards.ts:31-48` | ❌ 无 | ❌ 仅代码 |
| CP-P03 必须确认审核通过 | `prd-guards.ts:51-79` | ❌ 无 | ❌ 仅代码 |

---

## 分层原则分析

### 应该在代码层（程序化强制）的规则

**判断标准**：
- ✅ 技术约束（格式、类型、引用完整性）
- ✅ 流程门禁（状态机转换、确认点验证）
- ✅ 数据完整性（hash 一致性、计数正确性、版本匹配）
- ✅ 防御性检查（去重、循环引用、死锁）

**应保留在代码的规则**：
1. ✅ `decision_id` 不能重复（技术约束）
2. ✅ `source_ref` 必须在输入 sources 中（引用完整性）
3. ✅ `repo ref` 格式合法性（技术约束）
4. ✅ PRD version 语义版本格式（技术约束）
5. ✅ PRD hash 一致性（防篡改）
6. ✅ 审核版本匹配（数据完整性）
7. ✅ P0/P1/P2 计数正确性（数据完整性）
8. ✅ CP-P01/P02/P03 确认点守卫（流程门禁）

---

### 应该在 Skills 层（模型指令）的规则

**判断标准**：
- ✅ 业务语义约束（什么能写、什么不能写）
- ✅ 内容质量标准（完整性、合理性、一致性）
- ✅ 写作规范（结构、表达、风格）
- ✅ 产品哲学（取舍、优先级、用户价值）

**应优先在 Skills 的规则**：
1. ✅ "五不"清单（不写技术/设计/代码/废话/设限）—— **当前两层都缺**
2. ✅ 写作心法（减法优先、穿透本质、保持一致）—— **当前两层都缺**
3. ✅ 减法审查清单（必要性/频次/用户量等）—— **当前两层都缺**
4. ✅ 一致性审查 6 维度（术语/交互/架构等）—— **当前仅简单提及**
5. ✅ 阶段检查点（CORE 的关键检查项）—— **当前仅列章节**
6. ✅ 审核维度的详细 checklist —— **当前仅 7 维度标题**

---

### 可重复的规则（双层防护）

**判断标准**：既是业务语义约束，也需要程序化强制

**当前合理重复的规则**：
1. ✅ 必需章节检查（skills 指导写作，代码验证完整性）
2. ✅ 阻塞决策未确认不能 READY（skills 指导判断，代码门禁强制）
3. ✅ CONFIRMED 必须有 human_decision（skills 指导标记，代码验证完整性）
4. ✅ CORE 不得提前展开 DETAILS（skills 指导阶段，代码验证边界）
5. ✅ 存在 P0/P1 不能建议交付（skills 指导审核，代码门禁强制）

**原则**：重复不是问题，关键是**单一事实来源（Single Source of Truth）**
- Skills 层是"业务规则的权威定义"（人读）
- 代码层是"业务规则的程序化实施"（机读）
- Schema 是"数据契约的类型约束"（类型系统）

---

## 优化建议

### 优先级 P0（核心缺失）

**1. Skills 层增加"五不"清单**
- 文件：`skills/prd-write/prompt.md`
- 现状：❌ 两层都缺
- 影响：模型可能写入技术实现、设计参数、代码细节
- 行动：从 PRD skills.md 迁移"五不"清单

**2. Skills 层增加详细 checklist**
- 文件：`skills/prd-review/references/review-rubric.md`、`skills/prd-review/references/consistency-rubric.md`（新建）
- 现状：当前只有 7 个维度标题，无具体检查项
- 影响：审核不够细致，容易漏检
- 行动：从 PRD skills.md 迁移 A-L 12 维度检查清单

### 优先级 P1（质量提升）

**3. Skills 层增加阶段检查点**
- 文件：`skills/prd-write/references/stage-rules.md`
- 现状：只列必需章节，无检查点说明
- 影响：CORE 和 DETAILS 边界模糊
- 行动：增加"CORE 关键检查点"和"DETAILS 关键检查点"章节

**4. Skills 层增加写作心法**
- 文件：`skills/prd-write/references/writing-principles.md`（新建）
- 现状：❌ 无
- 影响：模型写作缺乏产品思维指导
- 行动：从 PRD skills.md 迁移三个心法 + 减法审查

**5. 增加负面示例**
- 文件：`skills/prd-write/examples/bad-examples.md`、`skills/prd-review/examples/typical-issues.md`（新建）
- 现状：❌ 无
- 影响：模型只知道"应该怎样"，不知道"不该怎样"
- 行动：从 PRD skills.md 提取错误示例

### 优先级 P2（架构清理）

**6. 代码层移除冗余提示文本**
- 文件：`validate-prd-output.ts`
- 现状：错误消息是中文提示（如"prd-thinking 不得输出 PRD artifact"）
- 问题：业务语义不应在代码层定义，应引用 Skills
- 行动：改为错误码 + Skills 引用（如 `errors.push("THINKING_001: 违反 prompt.md 规则 6")`）

---

## 架构原则总结

### 单一事实来源（SSOT）

```
业务规则的权威定义 → Skills 层（Markdown + Schema）
    ↓ 指导
模型生成输出 → 结构化 JSON
    ↓ 验证
程序化强制检查 → 代码层（TypeScript）
    ↓ 引用
错误消息 → 指向 Skills 层规则（不重复定义）
```

### 分层职责

| 层级 | 职责 | 形式 | 受众 |
|-----|------|------|------|
| **Skills 层** | 业务规则的权威定义 | Markdown（人读） + Schema（类型约束） | 模型 + 人 |
| **代码层** | 技术约束 + 流程门禁 + 数据完整性 | TypeScript | 运行时 |
| **重复区** | 关键业务规则双层防护 | Skills 定义 + 代码强制 | 模型 + 运行时 |

### 关键判断

**写在 Skills 层？**
- 是否需要模型理解业务语义？
- 是否需要人读懂规则？
- 是否是内容质量标准？

**写在代码层？**
- 是否是技术格式约束？
- 是否是流程状态门禁？
- 是否是数据完整性检查？

**双层防护？**
- 是否既需要模型指导，又需要运行时强制？
- 是否是核心业务约束（如阶段边界、决策确认）？

---

## 下一步行动

建议按 P0 → P1 → P2 顺序执行：

1. **P0-1**：`skills/prd-write/prompt.md` 增加"五不"清单
2. **P0-2**：`skills/prd-review/references/` 增加详细 checklist
3. **P1-3**：`skills/prd-write/references/stage-rules.md` 增加检查点
4. **P1-4**：`skills/prd-write/references/writing-principles.md` 新建
5. **P1-5**：`skills/*/examples/` 增加负面示例
6. **P2-6**：代码层错误消息改为引用 Skills（架构清理，非紧急）
