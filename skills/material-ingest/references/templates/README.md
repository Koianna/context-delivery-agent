# 模板索引

> 用途：说明可用的模板及其使用场景  
> 版本：2.0.0  
> 更新：2026-08-25

---

## 可用模板

| 模板文件 | 模板类型 | 适用场景 | 章节数 |
|---------|---------|---------|--------|
| meeting-notes.md | meeting-notes | 会议记录、讨论会、站会 | 6 |
| user-feedback.md | user-feedback | 用户反馈、客户反馈 | 6 |
| prd.md | prd | 产品需求文档、功能规格 | 6 |
| decision-record.md | decision-record | 决策记录、ADR | 6 |
| technical-spec.md | technical-spec | 技术文档、架构设计 | 6 |
| seven-sections.md | seven-sections | 通用材料整理（默认） | 7 |

---

## 模板选择逻辑

1. **根据内容类型自动选择**
   - MEETING_NOTE → meeting-notes.md
   - USER_FEEDBACK → user-feedback.md
   - PRODUCT_REQUIREMENT → prd.md
   - DECISION_RECORD → decision-record.md
   - TECHNICAL_SPEC → technical-spec.md
   - GENERAL → seven-sections.md（默认）

2. **配置控制**
   ```typescript
   template: {
     enable_flexible_template: true,   // 启用灵活模板
     use_seven_sections_default: false // 不强制使用7章节
   }
   ```

3. **默认行为**
   - 不启用灵活模板时，所有内容使用 seven-sections.md
   - 启用后，根据内容类型自动选择

---

## 模板格式

每个模板文件包含：
- 元数据（模板类型、适用场景、章节数）
- 章节标题和说明
- 使用 `---` 分隔章节

**示例**：
```markdown
# 模板标题

> 模板类型: template-type
> 适用场景: 场景说明
> 章节数: N

---

## 章节1标题

章节1说明

---

## 章节2标题

章节2说明
```

---

## 添加新模板

1. 创建新的模板文件：`templates/your-template.md`
2. 按照格式编写模板内容
3. 在本文件中添加索引条目
4. 在 `classification-rules.md` 中添加对应的内容类型

---

## 修改现有模板

1. 找到对应的模板文件
2. 修改章节标题或说明
3. 保存文件
4. 规则引擎会自动读取新内容
