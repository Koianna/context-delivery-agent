# 规则单一事实来源（SSOT）优化方案

## 核心原则

**避免双层维护**：每条规则只在一层定义，另一层引用或动态读取。

```
规则的唯一权威定义 → Skills 层 或 代码层（二选一）
                    ↓
            另一层引用/读取该定义
```

---

## 重复规则优化方案

### 规则 1：不得输出 PRD artifact

**现状**：
- 代码层：`validate-prd-output.ts:11` 硬编码检查
- Skills 层：`prompt.md:14` 文本说明

**问题**：修改 Skills 层说明，代码层检查不会变

**优化方案**：
- ✅ **保留在代码层**（技术约束，防止模型输出格式错误）
- ❌ **Skills 层改为引用**：`prompt.md` 改为"见输出契约 schema.json，不包含 prd_artifact 字段"
- **原因**：这是 schema 强制约束，Skills 只需说明"按 schema 输出"

---

### 规则 2：优先问题不超过 3 个

**现状**：
- 代码层：`validate-prd-output.ts:12` 硬编码数字 3
- Skills 层：`prompt.md:13` 文本说明"不超过三个"

**问题**：想改成 5 个，需要改两处

**优化方案**：
- ✅ **保留在 Skills 层**（业务规则，可能调整）
- ❌ **代码层改为读取 Skills**：从 `prompt.md` 或 `references/constraints.json` 读取上限
- **实现**：
  ```typescript
  // 从 Skills 配置读取
  const MAX_PRIORITY_QUESTIONS = readSkillConfig('prd-thinking').maxPriorityQuestions || 3;
  if (output.writable_assessment.priority_questions.length > MAX_PRIORITY_QUESTIONS) {
    errors.push(`优先问题超过 ${MAX_PRIORITY_QUESTIONS} 个`);
  }
  ```

---

### 规则 3：阻塞决策未确认时不能标记 READY

**现状**：
- 代码层：`validate-prd-output.ts:14-15` 硬编码逻辑
- Skills 层：`writable-rules.md:9` READY 条件

**问题**：想调整 READY 条件（如允许有 1 个非阻塞的 PENDING），需要改两处

**优化方案**：
- ✅ **保留在 Skills 层**（业务规则定义）
- ❌ **代码层改为读取 Skills**：从 `writable-rules.md` 或配置文件读取 READY 条件
- **实现**：
  ```typescript
  // 从 Skills 规则读取
  const readyRules = readSkillRules('prd-thinking', 'writable-rules.md');
  const pendingBlocking = output.decision_ledger.filter((item) => 
    item.is_blocking && item.status !== "CONFIRMED"
  );
  if (pendingBlocking.length && output.writable_assessment.status === "READY") {
    errors.push(readyRules.blockingDecisionError); // 从 Skills 读取错误消息
  }
  ```

---

### 规则 4：CONFIRMED 必须有 human_decision

**现状**：
- 代码层：`validate-prd-output.ts:21-23` 硬编码
- Skills 层：`prompt.md:10` 文本说明

**问题**：这是数据完整性约束，修改可能性低

**优化方案**：
- ✅ **保留在代码层**（数据完整性，技术约束）
- ⚠️ **Skills 层改为引用**：`prompt.md` 改为"CONFIRMED 状态的完整性约束见 schema.json"
- **原因**：这是数据契约，应该由 schema + 代码强制

---

### 规则 5：必需章节检查

**现状**：
- 代码层：`validate-prd-output.ts:63-66, 80-84` 硬编码章节列表
- Skills 层：`stage-rules.md` 列出必需章节

**问题**：想调整必需章节（如 CORE 增加"术语与定义"），需要改两处

**优化方案**：
- ✅ **保留在 Skills 层**（业务规则，可能调整）
- ❌ **代码层改为读取 Skills**：
  ```typescript
  // 从 Skills 读取必需章节
  const stageRules = readSkillRules('prd-write', 'stage-rules.md');
  const requiredSections = artifact.phase === "CORE" 
    ? stageRules.coreRequiredSections 
    : stageRules.detailsRequiredSections;
  
  for (const section of requiredSections) {
    if (!body.includes(section)) errors.push(`${artifact.phase} 缺少章节: ${section}`);
  }
  ```

**配置化方案**（推荐）：
- 在 `skills/prd-write/references/stage-rules.json` 定义：
  ```json
  {
    "CORE": {
      "required_sections": ["背景与问题", "产品目标", "核心流程"],
      "forbidden_sections": ["验收标准", "角色与权限"]
    },
    "DETAILS": {
      "required_sections": ["功能规则", "角色与权限", "边界与异常", "验收标准"]
    }
  }
  ```

---

### 规则 6：CORE 不得提前展开 DETAILS 内容

**现状**：
- 代码层：`validate-prd-output.ts:77-79` 正则匹配 `## (8|9|10)\.|验收标准|角色与权限`
- Skills 层：`stage-rules.md:15` 文本说明

**问题**：想调整禁止章节（如允许 CORE 包含"角色定义"但不包含"权限矩阵"），需要改两处

**优化方案**：
- ✅ **保留在 Skills 层**（业务规则）
- ❌ **代码层改为读取 Skills**：
  ```typescript
  const stageRules = readSkillRules('prd-write', 'stage-rules.json');
  const forbiddenPattern = new RegExp(stageRules.CORE.forbiddenPattern);
  if (artifact.phase === "CORE" && forbiddenPattern.test(body)) {
    errors.push("CORE 候选提前展开 DETAILS 内容");
  }
  ```

---

### 规则 7：存在 P0/P1 不能建议交付

**现状**：
- 代码层：`validate-prd-output.ts:114-116` 硬编码
- Skills 层：`prompt.md:14` 文本说明

**问题**：想调整为"允许 1 个 P1 但必须有缓解措施"，需要改两处

**优化方案**：
- ✅ **保留在 Skills 层**（业务规则）
- ❌ **代码层改为读取 Skills**：
  ```typescript
  const reviewRules = readSkillRules('prd-review', 'review-rubric.json');
  if (!reviewRules.canDeliver(counts)) {
    errors.push("审核结果不满足交付条件");
  }
  ```

---

### 规则 8：Schema 约束（material_classification 必填、枚举合法性）

**现状**：
- 代码层：`validate-prd-output.ts:26-38` 硬编码枚举
- Schema 层：`schema.json` 类型约束

**问题**：想新增 category 类型（如 "external_api_doc"），需要改三处（schema + 代码 + prompt）

**优化方案**：
- ✅ **保留在 Schema 层**（类型约束）
- ❌ **代码层改为读取 Schema**：
  ```typescript
  const schema = readSkillSchema('prd-thinking');
  const validCategories = new Set(schema.properties.background_card.properties.material_classification.items.properties.category.enum);
  
  if (!validCategories.has(item.category)) {
    errors.push(`material_classification 中 category 非法: ${item.category}，合法值: ${Array.from(validCategories).join(', ')}`);
  }
  ```

---

## 架构实现方案

### 方案 A：配置化（推荐）

**结构**：
```
skills/prd-thinking/
  ├── schema.json              # 类型约束（唯一定义）
  ├── prompt.md                # 模型指令（引用 constraints.json）
  └── references/
      └── constraints.json     # 业务规则配置（唯一定义）
          {
            "maxPriorityQuestions": 3,
            "readyConditions": {
              "allowBlockingPending": false,
              "allowNonBlockingPending": true
            }
          }

scripts/validate-prd-output.ts
  └── 读取 skills/*/references/constraints.json
```

**优点**：
- ✅ 规则修改只需改 JSON，代码和 prompt 自动同步
- ✅ 支持运行时热更新
- ✅ 易于测试（mock 配置文件）

---

### 方案 B：Schema 驱动（适合类型约束）

**结构**：
```
skills/prd-thinking/
  └── schema.json              # 唯一定义（含枚举、必填、格式）

scripts/validate-prd-output.ts
  └── 读取 schema.json，动态生成校验逻辑
```

**实现**：
```typescript
import Ajv from 'ajv';
const ajv = new Ajv();
const schema = readSkillSchema('prd-thinking');
const validate = ajv.compile(schema);

if (!validate(output)) {
  errors.push(...validate.errors.map(e => e.message));
}
```

**优点**：
- ✅ Schema 即文档，即校验
- ✅ 修改 schema 自动更新校验逻辑
- ✅ 符合 JSON Schema 标准

---

### 方案 C：Skills 文档解析（适合复杂规则）

**结构**：
```
skills/prd-write/
  └── references/
      └── stage-rules.md       # Markdown 文档（唯一定义）
          ## CORE 必需章节
          - 背景与问题
          - 产品目标
          - 核心流程
          
          ## CORE 禁止内容
          - 验收标准
          - 角色与权限

scripts/lib/skill-parser.ts
  └── 解析 Markdown，提取结构化规则
```

**实现**：
```typescript
const stageRules = parseMarkdownRules('prd-write', 'stage-rules.md');
// 返回：{ CORE: { required: [...], forbidden: [...] } }
```

**优点**：
- ✅ Skills 文档保持人类可读
- ✅ 规则修改无需改代码
- ⚠️ 解析逻辑复杂

---

## 推荐架构（混合方案）

| 规则类型 | 定义位置 | 代码层实现 |
|---------|---------|-----------|
| **类型约束**（枚举、必填、格式） | `schema.json` | 读取 schema + Ajv 校验 |
| **业务数值**（上限、阈值） | `references/constraints.json` | 读取 JSON 配置 |
| **章节规则**（必需/禁止） | `references/stage-rules.json` | 读取 JSON 配置 |
| **复杂逻辑**（READY 条件） | `references/constraints.json` | 读取 JSON + 实现逻辑 |

---

## 优化行动计划

### Phase 1：配置化核心业务规则

1. **创建配置文件**：
   - `skills/prd-thinking/references/constraints.json`
   - `skills/prd-write/references/stage-rules.json`
   - `skills/prd-review/references/delivery-rules.json`

2. **代码层改为读取配置**：
   - `scripts/lib/skill-config.ts`（新建）：提供 `readSkillConfig()` 函数
   - `scripts/validate-prd-output.ts`：所有硬编码数值/章节改为读取配置

3. **Skills 层改为引用配置**：
   - `prompt.md`：硬编码数值改为 `见 references/constraints.json`

### Phase 2：Schema 驱动类型校验

1. **增强 schema.json**：
   - 补充完整的枚举定义、格式约束
   - 使用 JSON Schema 标准特性（pattern、minItems、maxItems）

2. **代码层改为 Schema 驱动**：
   - 使用 Ajv 或等价库自动校验
   - 移除硬编码的枚举检查

### Phase 3：移除冗余规则

1. **审计所有重复规则**：
   - 列出代码层和 Skills 层的重复定义
   - 判断保留在哪一层

2. **清理代码层**：
   - 移除业务规则硬编码
   - 改为读取 Skills 配置

3. **清理 Skills 层**：
   - 移除引用代码层的规则（改为"见 schema"）

---

## 测试策略

### 单元测试

```typescript
describe('validatePrdThinking', () => {
  it('should read maxPriorityQuestions from skill config', () => {
    const config = { maxPriorityQuestions: 5 }; // mock 配置
    const output = { ..., priority_questions: [1,2,3,4,5] };
    const errors = validatePrdThinking(output, config);
    expect(errors).toEqual([]); // 5 个不超限
  });
});
```

### 集成测试

```typescript
describe('skill config integration', () => {
  it('should sync between skills/prompt.md and validation', () => {
    const config = readSkillConfig('prd-thinking');
    const promptText = fs.readFileSync('skills/prd-thinking/prompt.md', 'utf-8');
    
    // 确保 prompt 引用了配置，而不是硬编码
    expect(promptText).toContain('见 references/constraints.json');
    expect(promptText).not.toContain('不超过 3 个'); // 硬编码数值
  });
});
```

---

## 关键原则

1. **规则只在一层定义**（SSOT）
2. **另一层通过配置/Schema 读取**（动态引用）
3. **优先保留在 Skills 层**（业务规则可能调整）
4. **代码层保留技术约束**（数据完整性、流程门禁）
5. **Schema 保留类型约束**（枚举、必填、格式）
