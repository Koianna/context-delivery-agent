# 内容分类规则

> 版本：2.0.0  
> 更新：2026-08-25  
> 用途：定义如何识别材料的内容类型

---

## 一、信息单元分类（原有）

| 类型 | 判断标准 | 默认成熟度 |
|---|---|---|
| `USER_FEEDBACK` | 用户原话、工单或访谈反馈 | `UNCONFIRMED` |
| `OBSERVATION` | 基于多个现象形成但尚未验证的归纳 | `UNCONFIRMED` |
| `FACT` | 可由当前系统、文档或记录直接核验 | `CONFIRMED` 或 `UNCONFIRMED` |
| `DATA` | 有数值、样本和口径的数据 | 由来源完整性决定 |
| `OPINION` | 某个角色的主观看法 | `UNCONFIRMED` |
| `PROPOSAL` | 尚未批准的方案或动作建议 | `UNCONFIRMED` |
| `CONFIRMED_DECISION` | 有明确决策主体和确认动作的结论 | `CONFIRMED` |

**会议场景判断标准**：
- ✅ 决策："团队决定 X"、"最终确定 X"、"大家一致同意 X"
- ❌ 提议："有人建议 X"、"可以考虑 X"、"我觉得 X"
- 未达成共识的讨论仍为 `PROPOSAL` 或 `OPEN_QUESTION`
| `OPEN_QUESTION` | 仍需回答且会影响后续工作的事项 | `UNCONFIRMED` |
| `DEPRECATED_CONTENT` | 已被明确替代或不再适用的内容 | `SUPERSEDED` |

---

## 二、内容类型识别（新增）

用于识别整个材料的主题类型，决定使用哪种模板。

### 规则格式

```yaml
类型名称:
  - 触发条件: [source_type匹配 | 文件名匹配]
  - 关键词: [关键词列表]
  - 置信度: high | medium | low
  - 优先级: 数字（越小越优先）
```

---

### 1. MEETING_NOTE（会议记录）

**触发条件**：
- source_type 精确匹配: `MEETING`, `MEETING_NOTE`
- 文件名包含关键词（不区分大小写）

**关键词**：
- 中文: 会议, 纪要, 讨论会, 站会, 周会, 月会, kick-off
- 英文: meeting, minutes, standup, sync

**置信度**: high  
**优先级**: 1

---

### 2. USER_FEEDBACK（用户反馈）

**触发条件**：
- source_type 精确匹配: `USER_FEEDBACK`, `FEEDBACK`
- 文件名包含关键词

**关键词**：
- 中文: 用户反馈, 客户反馈, 反馈汇总, 客服反馈
- 英文: feedback, user-feedback, customer-feedback, bug-report

**置信度**: high  
**优先级**: 2

---

### 3. PRODUCT_REQUIREMENT（产品需求）

**触发条件**：
- source_type 精确匹配: `PRODUCT_REQUIREMENT`, `PRD`, `REQUIREMENT`
- 文件名包含关键词

**关键词**：
- 中文: 产品需求, 需求文档, 功能需求, 需求整理
- 英文: prd, product-requirement, requirement, requirements

**置信度**: high  
**优先级**: 3

---

### 4. DECISION_RECORD（决策记录）

**触发条件**：
- source_type 精确匹配: `DECISION_RECORD`, `DECISION`
- 文件名包含关键词

**关键词**：
- 中文: 决策, 决定, 讨论结论
- 英文: decision-record, decision, adr, conclusion

**置信度**: medium  
**优先级**: 4

---

### 5. PRODUCT_DOC（产品文档）

**触发条件**：
- 文件名包含关键词

**关键词**：
- 中文: 产品文档, 功能说明, 产品介绍
- 英文: product-doc, feature-doc, product-guide

**置信度**: medium  
**优先级**: 5

---

### 6. TECHNICAL_SPEC（技术规格）

**触发条件**：
- 文件名包含关键词

**关键词**：
- 中文: 技术规格, 技术文档, 架构设计
- 英文: technical-spec, tech-spec, architecture, api-doc

**置信度**: medium  
**优先级**: 6

---

### 7. GENERAL（通用/默认）

**触发条件**：
- 无法匹配以上任何类型

**关键词**: 无  
**置信度**: low  
**优先级**: 999

---

## 三、匹配逻辑

### 匹配流程

1. **精确匹配 source_type**（优先级最高）
   - 如果 `source_type` 字段完全匹配某个规则的精确值
   - 直接返回该类型，置信度 = high

2. **关键词匹配**（次优先级）
   - 将 source_type、材料名称合并为文本
   - 转为小写
   - 检查是否包含任何关键词
   - 如果匹配，返回该类型及其置信度

3. **按优先级排序**
   - 多个规则匹配时，选择优先级最高的（数字最小）

4. **默认值**
   - 无匹配时，返回 GENERAL，置信度 = low

---

## 四、AI 辅助分类（可选）

当规则匹配置信度为 `low` 时，可以调用 AI 进行辅助判断。

**AI 提示词模板**：
```
根据以下材料信息，判断其内容类型：

材料信息：
- source_type: {source_type}
- 材料名称: {name}
- 材料内容摘要: {content_preview}

可选类型：
1. MEETING_NOTE - 会议记录
2. USER_FEEDBACK - 用户反馈
3. PRODUCT_REQUIREMENT - 产品需求
4. DECISION_RECORD - 决策记录
5. PRODUCT_DOC - 产品文档
6. TECHNICAL_SPEC - 技术规格
7. GENERAL - 通用

请返回最匹配的类型和置信度（high/medium/low）。
```

---

## 五、使用说明

### 修改分类规则

**添加新类型**：
1. 在"二、内容类型识别"中添加新的规则
2. 定义触发条件和关键词
3. 设置置信度和优先级

**修改现有规则**：
1. 找到对应的类型
2. 修改关键词列表
3. 调整置信度或优先级

**示例**：

如果想让"周报"也识别为 MEETING_NOTE：
```markdown
### 1. MEETING_NOTE（会议记录）

关键词：
- 中文: 会议, 纪要, 讨论会, 站会, 周会, 月会, kick-off, 周报  ← 新增
```

---

## 六、停用词列表

这些词在语义匹配时会被过滤掉：

**中文停用词**：
```
的, 了, 和, 是, 在, 有, 我, 你, 他, 她, 它,
这, 那, 个, 们, 与, 及, 或, 等, 中, 内,
整理, 记录, 分析, 讨论, 总结, 归纳
```

**英文停用词**：
```
the, a, an, and, or, but, in, on, at, to, for,
of, with, by, from, as, is, was, are, be, been,
organize, record, analyze, discuss, summary
```

**修改方法**：
- 直接在列表中添加或删除词语
- 规则引擎会自动读取

---

## 七、层级规则（原有）

- 元数据完整且已明确确认的信息可建议进入 `CONTEXT`，但仍须通过 CP-C01。
- 未确认的事实、观察、提案和问题进入 `WORKSPACE`。
- 缺少来源负责人、来源时间或可定位证据的信息进入 `DRAFTS`。
- 历史材料不等于失效材料；只有存在明确失效依据时才标记 `DEPRECATED_CONTENT`。

---

## 八、证据规则（原有）

证据必须包含 `source_id`、`location` 和 `quote`。`quote` 应是足以支持该信息单元的最短原文，不能用分析结论替代原文。

---


