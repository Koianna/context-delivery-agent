# context-workspace 目录组织规则

> 版本：2.1.0  
> 更新：2026-08-25  
> 参考：context-engineer 设计原则  
> 状态：已完整实现索引系统、智能路由、模板系统、维护能力和规则驱动架构

---

## 一、核心设计原则

### 1.1 内容优先于结构

**原则**：不预先创建空目录，有内容才建文件

**错误做法**：
```
context/
├── 01_product/      ← 空目录
├── 02_features/     ← 空目录
├── 03_customers/    ← 空目录
└── 04_competitors/  ← 空目录
```

**正确做法**：
```
context/
├── product-overview.md   ← 有真实内容
└── terminology.md        ← 有真实内容
```

### 1.2 用户可读优先

**文件命名规则**：

| 内容类型 | 命名规则 | 示例 |
|---------|---------|------|
| 时间性内容 | `{date}-{topic}.md` | `2026-08-20-kickoff会议.md` |
| 持久性内容 | `{topic}.md` | `需求整理.md`、`产品定位.md` |

**为什么**：
- 用户通过文件名直接理解内容
- 时间性内容按时间排序，便于查看演进
- 持久性内容通过主题名快速定位

**自动命名清洗**（已实现）：
- 移除口语化前缀："这是"、"这个是" → 清除
- 移除动作词："整理一下"、"记录一下" → 清除
- 移除冗余结构："的范围"、"的内容" → 清除
- 示例：`"这是企业知识库问答助手 MCP 的范围，整理一下"` → `"企业知识库问答助手-MCP.md"`

### 1.3 三层生命周期模型

```
drafts/      → 低可信度，正在形成的想法
  ↓ 人工确认 或 智能路由
workspace/   → 中可信度，正在进行的工作
  ↓ CP-C01 确认
context/     → 高可信度，已确认的知识
```

**关键规则**：
1. **不自动提升**：从 drafts → workspace 需要人工判断（或启用智能路由）
2. **When in doubt, drafts**：不确定时默认放 drafts
3. **错误代价不对称**：放错到 context 比放错到 drafts 危害更大

**智能路由规则**（可选启用）：
- 会议记录 → `drafts/`
- 用户反馈 → `drafts/`
- 有明确所有者+时间线的任务 → `workspace/`
- 已确认标记的知识 → `context/`（需人工确认）

---

## 二、目录结构

### 2.1 标准结构

```
context-workspace/
├── CLAUDE.md                    ← 根索引 ✅ 已实现
├── drafts/                      ← 原始材料，低可信度
│   └── {project_id}/
│       ├── CLAUDE.md            ← 项目索引 ✅ 已实现
│       ├── README.md            ← 材料清单（Runtime维护）
│       ├── 需求整理.md          ← 持久性内容，追加更新
│       ├── 用户反馈汇总.md      ← 用户反馈汇总
│       ├── 2026-08-20-会议.md   ← 时间性内容，独立记录
│       └── source-materials/    ← 原文归档
│           ├── {task_id_1}/
│           │   └── materials.md
│           └── {task_id_2}/
│               └── materials.md
├── workspace/                   ← 进行中的工作，中可信度
│   ├── projects/
│   │   └── {project_id}/
│   │       ├── CLAUDE.md        ← 项目索引 ✅ 已实现
│   │       └── {files}.md
│   ├── prd/
│   │   ├── CLAUDE.md            ← 自动维护 ✅
│   │   └── {project_id}-{task_id}.md
│   ├── decisions/
│   │   ├── CLAUDE.md            ← 自动维护 ✅
│   │   └── {project_id}/
│   └── reports/
│       ├── CLAUDE.md            ← 自动维护 ✅
│       └── change-impact-*.json
└── context/                     ← 已确认知识，高可信度
    └── {project_id}/
        ├── CLAUDE.md            ← 项目索引 ✅ 已实现
        ├── product-overview.md
        └── terminology.md
```

### 2.2 索引系统（已实现）

**CLAUDE.md 索引文件**：
- 每个目录自动生成和维护
- 包含：目录用途、文件列表、一行摘要、使用规则
- AI 通过索引快速导航："未索引的文件对 AI 不可见"

**索引内容示例**：
```markdown
# default-project (drafts 层)

## Purpose
default-project 项目的 drafts 层 材料

## Files
- **[需求整理.md](需求整理.md)** — 企业知识库问答助手需求 (2026-08-25)
- **[用户反馈汇总.md](用户反馈汇总.md)** — 用户反馈汇总 (2026-08-24)

## Rules
- 材料按主题组织，持久性内容追加更新
- 时间性内容（会议记录）独立记录
- 原始材料保留在 source-materials/ 中
```

**自动更新时机**：
- 每次材料整理后自动更新项目索引和根索引
- 可通过配置关闭：`indexing: { auto_update: false }`

### 2.3 子目录创建规则

**延迟创建原则**：只有当目录积累 **7+ 个相似主题的文件** 时，才创建子目录

**示例**：

```
# 初始状态（5 个文件）
context/
├── product-overview.md
├── feature-auth.md
├── feature-payments.md
├── feature-notifications.md
└── terminology.md

# 达到 7+ 个 feature 文件后
context/
├── product-overview.md
├── terminology.md
└── features/              ← 现在才创建
    ├── auth.md
    ├── payments.md
    ├── notifications.md
    ├── analytics.md
    ├── api.md
    ├── webhooks.md
    └── integrations.md
```

---

## 三、智能分类与路由（已实现）

### 3.1 内容自动分类

**10+ 规则覆盖主要类型**：

| 内容类型 | 识别特征 | 置信度 |
|---------|---------|--------|
| MEETING_NOTE | source_type="MEETING" 或 包含"会议"、"纪要" | high |
| USER_FEEDBACK | source_type="USER_FEEDBACK" 或 包含"用户反馈" | high |
| PRODUCT_REQUIREMENT | source_type="PRODUCT_REQUIREMENT" 或 包含"PRD"、"需求文档" | high |
| DECISION_RECORD | 包含"决策"、"决定"、"讨论结论" | medium |
| PRODUCT_DOC | 包含"产品文档"、"功能说明" | medium |
| TECHNICAL_SPEC | 包含"技术规格"、"架构设计" | medium |
| GENERAL | 无明确特征 | low |

**AI 辅助分类**（可选）：
- 规则匹配置信度低时，可调用 AI 辅助判断
- 配置：`classification: { use_ai_assist: true }`

### 3.2 智能层级路由

**路由规则**（可选启用）：

```
1. 明确标记为"已确认" → context（需人工确认）
2. 有明确所有者+时间线 → workspace
3. PRD 且处于活跃状态 → workspace
4. 会议记录 → drafts
5. 用户反馈 → drafts
6. 决策记录 → drafts（待确认后提升）
7. 默认 → drafts（When in doubt, drafts）
```

**启用方式**：
```typescript
config: {
  routing: { enable_smart_routing: true }
}
```

### 3.3 语义匹配（已实现）

**识别相关主题**：
- 使用 Jaccard 相似度算法（词集交集/并集）
- 停用词过滤（"的"、"了"、"整理"等）
- 相似度阈值：默认 70%

**示例**：
- "需求整理" 和 "产品需求" → 相似度 85% → 识别为同一主题
- "企业知识库" 和 "知识库问答" → 相似度 75% → 识别为同一主题

**启用方式**：
```typescript
config: {
  file_decision: { enable_semantic_match: true }
}
```

---

## 四、文件命名与决策

### 4.1 文件命名逻辑

**主题提取优先级**：

```
1. 从 task_goal 提取（最准确）
   "整理知识库问答助手需求" → "知识库问答助手"

2. 从 analysis_scope.topic 提取
   topic: "帮助中心搜索优化" → "帮助中心搜索优化"

3. 从第一个材料的名称提取
   name: "2026-08-20-需求讨论.md" → "需求讨论"

4. 从 project_id 推断
   project_id: "knowledge-qa-assistant" → "知识库问答助手"
```

**命名清洗**（9步）：
1. 移除开头引导词："这是"、"这个是"
2. 移除复合动词："整理一下"、"记录一下"
3. 移除单独动词："整理"、"记录"
4-5. 移除结尾口语词
6-7. 移除冗余结构："的范围"、"的内容"
8-9. 清理"的"、"材料"、多余空格

### 4.2 日期提取优先级

```
1. 从 source_time 提取（最可靠）
   source_time: "2026-08-20T10:00:00Z" → "2026-08-20"

2. 从 material.name 中提取日期模式
   - "2026-08-20-会议记录.md" → "2026-08-20"
   - "2026年8月20日会议.md" → "2026-08-20"

3. 使用当前日期
   new Date().toISOString().split('T')[0]
```

### 4.3 文件操作决策

**决策流程**（增强版）：

```
生成文件名
  ↓
1. 精确文件名匹配？
   ├─ 是 → 检查时间间隔
   │       ├─ 时间性内容 → 创建新文件
   │       └─ < 7天 → 追加；≥ 7天 → 创建
   └─ 否 ↓
2. 启用语义匹配？
   ├─ 是 → 查找相似主题
   │       ├─ 找到且 < 7天 → 追加到匹配文件
   │       └─ 否 → 创建新文件
   └─ 否 → 创建新文件
```

**配置选项**：
```typescript
file_decision: {
  append_threshold_days: 7,          // 追加阈值
  enable_semantic_match: true,       // 语义匹配
  semantic_threshold: 0.7            // 相似度阈值
}
```

---

## 五、模板系统（已实现）

### 5.1 灵活模板

**5种专业模板**：

| 模板类型 | 适用场景 | 章节结构 |
|---------|---------|---------|
| **meeting-notes** | 会议记录 | 会议概要、关键讨论、决策事项、行动项、未决问题、补充说明 |
| **user-feedback** | 用户反馈 | 反馈来源、问题痛点、功能需求、改进建议、正面反馈、优先级评估 |
| **decision-record** | 决策记录 | 决策背景、考虑方案、最终决策、影响范围、执行计划、后续跟进 |
| **prd** | 产品需求 | 需求背景、目标用户、核心功能、业务规则、成功指标、依赖与风险 |
| **technical-spec** | 技术规格 | 技术概述、架构设计、接口定义、技术选型、性能安全、实施计划 |
| **seven-sections** | 默认通用 | 背景与事实、用户反馈、观点与方案、已确认决策、行动项、风险、来源材料 |

**自动选择逻辑**：
- 根据内容分类结果自动选择对应模板
- 默认使用 seven-sections（向后兼容）

**启用方式**：
```typescript
config: {
  template: { enable_flexible_template: true }
}
```

### 5.2 模板示例

**会议记录模板**：
```markdown
# 会议记录

## 会议概要
_会议时间、参与人员、会议主题_

## 关键讨论
_讨论的主要议题和观点_

## 决策事项
_会议中达成的决策和结论_

## 行动项
_待办事项、负责人、截止时间_

## 未决问题
_需要后续确认或讨论的问题_

## 补充说明
_AI理解所需的背景信息_
```

---

## 六、维护能力（已实现）

### 6.1 自动维护检查

**维护项目**：

1. **索引同步检查**
   - 检测缺失的 CLAUDE.md 索引文件
   - 检测索引中列出但不存在的文件
   - 检测未在索引中列出的文件

2. **陈旧内容检测**
   - drafts 超过 30 天 → 提示提升或删除
   - workspace 超过 90 天 → 提示归档或提升到 context

3. **自动修复**
   - 重新生成缺失的索引文件
   - 更新不同步的索引内容

**使用方式**：
```typescript
import { performMaintenance, autoFixIndexSync } from './scripts/lib/maintain.js';

// 执行检查
const report = await performMaintenance(workspaceRoot);
console.log(report.summary);

// 自动修复
const fixed = await autoFixIndexSync(workspaceRoot);
console.log(`修复了 ${fixed} 个问题`);
```

### 6.2 维护报告

**报告内容**：
```markdown
# 维护报告

⚠️ 发现 3 个索引同步问题

## 索引同步问题

- **missing_in_index**: workspace/prd
  - 理由: 项目目录缺少 CLAUDE.md 索引文件

- **missing_file**: drafts/default-project/旧文件.md
  - 理由: 索引中的文件不存在

## 陈旧内容

- **drafts/old-project/需求.md**
  - 最后更新: 45 天前
  - 建议: 考虑提升到 workspace 或删除
```

---

## 七、元数据管理

### 7.1 Frontmatter 结构

每个文件都包含 frontmatter：

```yaml
---
artifact_id: {project_id}-materials
version: 0.1.0
project_id: {project_id}
content_type: PRODUCT_REQUIREMENT | MEETING_NOTE | USER_FEEDBACK | ...
created_at: 2026-08-20T10:00:00Z
updated_at: 2026-08-20T10:00:00Z
task_history:
  - {"task_id":"agent-xxx","updated_at":"2026-08-20T10:00:00Z","material_count":3,"summary":"初始需求整理"}
source_refs:
  - repo://context-workspace/drafts/{project_id}/source-materials/{task_id}/materials.md
---
```

### 7.2 版本管理

**版本号格式**：语义化版本 `{major}.{minor}.{patch}`

**递增规则**：
- 创建新文件：`0.1.0`
- 追加内容：递增 patch 版本（`0.1.0` → `0.1.1` → `0.1.2`）
- 重大更新：递增 minor 版本（`0.1.x` → `0.2.0`）

### 7.3 task_history 追踪

每次追加内容时，在 `task_history` 中记录：

```json
{
  "task_id": "agent-1787559564133",
  "updated_at": "2026-08-20T10:00:00Z",
  "material_count": 3,
  "summary": "初始需求整理"
}
```

**用途**：
- 追溯每次更新的来源
- 了解文件的演进历史
- 定位原始材料

---

## 八、配置系统（已实现）

### 8.1 配置选项

```typescript
interface IngestConfig {
  // 内容分类
  classification: {
    use_ai_assist: boolean;           // 启用AI辅助分类
    confidence_threshold: number;     // 置信度阈值（0-1）
  };

  // 目录路由
  routing: {
    enable_smart_routing: boolean;    // 启用智能路由
    default_layer: 'drafts' | 'workspace';
    require_context_confirmation: boolean;
  };

  // 文件决策
  file_decision: {
    append_threshold_days: number;    // 追加阈值（默认7天）
    enable_semantic_match: boolean;   // 启用语义匹配
    semantic_threshold: number;       // 语义相似度阈值（0-1）
  };

  // 索引维护
  indexing: {
    auto_update: boolean;             // 自动更新索引
    include_summary: boolean;         // 包含文件摘要
  };

  // 模板系统
  template: {
    enable_flexible_template: boolean;    // 启用灵活模板
    use_seven_sections_default: boolean;  // 默认使用7章节
  };

  // 用户交互
  confirmation: {
    require_layer: boolean;           // 层级路由确认
    require_filename: boolean;        // 文件名确认
    require_append: boolean;          // 追加操作确认
  };
}
```

### 8.2 默认配置

**完全向后兼容**：
```typescript
const DEFAULT_CONFIG = {
  classification: { use_ai_assist: false },
  routing: { enable_smart_routing: false },      // 固定 drafts
  file_decision: { enable_semantic_match: false }, // 不启用
  indexing: { auto_update: true },               // ✅ 自动更新索引
  template: { enable_flexible_template: false }, // 使用7章节
  confirmation: { require_layer: false }
};
```

### 8.3 推荐配置

**启用所有智能功能**：
```typescript
const RECOMMENDED_CONFIG = {
  classification: { use_ai_assist: true },
  routing: { enable_smart_routing: true },       // 智能路由
  file_decision: { enable_semantic_match: true }, // 语义匹配
  indexing: { auto_update: true },
  template: { enable_flexible_template: true },  // 灵活模板
  confirmation: { require_layer: false }
};
```

---

## 九、使用场景

### 场景 1：首次提交需求材料（默认模式）

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 需求讨论文档
- task_goal: "整理知识库问答助手需求"

**输出**：
```
drafts/knowledge-qa-assistant/
├── CLAUDE.md                ← 自动生成索引 ✅
├── README.md
├── 需求整理.md              ← 新建文件，7章节模板
└── source-materials/
    └── agent-1787559564133/
        └── materials.md
```

### 场景 2：补充需求材料（3天后）

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 功能补充文档
- task_goal: "补充知识库问答助手功能点"

**输出**：
```
drafts/knowledge-qa-assistant/
├── CLAUDE.md                ← 自动更新 ✅
├── 需求整理.md              ← 追加内容（< 7天）
└── source-materials/
    └── agent-1787623456789/
        └── materials.md
```

### 场景 3：会议记录（启用灵活模板）

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 会议记录
- task_goal: "2026-08-20 产品讨论会"
- config: `{ template: { enable_flexible_template: true } }`

**输出**：
```
drafts/knowledge-qa-assistant/
├── CLAUDE.md                       ← 自动更新 ✅
├── 2026-08-20-产品讨论会.md        ← 使用会议记录模板 ✅
└── source-materials/
    └── agent-xxx/
        └── materials.md
```

### 场景 4：智能路由（启用智能路由）

**输入**：
- project_id: `new-feature`
- materials: PRD 文档
- task_goal: "新功能 PRD，张三负责，本月底完成"
- config: `{ routing: { enable_smart_routing: true } }`

**输出**：
```
workspace/projects/new-feature/     ← 智能路由到 workspace ✅
├── CLAUDE.md                       ← 自动生成 ✅
├── 新功能-PRD.md                   ← 使用 PRD 模板（如启用）
└── ...
```

### 场景 5：语义匹配（启用语义匹配）

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 新需求
- task_goal: "产品需求补充"
- config: `{ file_decision: { enable_semantic_match: true } }`
- 现有文件：`需求整理.md`（3天前更新）

**输出**：
```
drafts/knowledge-qa-assistant/
├── 需求整理.md              ← 语义匹配识别，追加到此文件 ✅
└── ...

（而不是创建新的 "产品需求.md"）
```

---

## 十、与 context-engineer 对齐情况

| 能力 | context-engineer | 当前实现 | 完成度 |
|------|------------------|---------|--------|
| **索引系统** | ✅ CLAUDE.md | ✅ 已实现 | 100% |
| **内容分类** | ✅ AI理解 | ✅ 规则+AI预留 | 95% |
| **智能路由** | ✅ AI判断 | ✅ 智能规则路由 | 90% |
| **语义匹配** | ✅ AI语义 | ✅ Jaccard+编辑距离 | 90% |
| **模板系统** | ✅ 20+模板 | ✅ 5种专业模板 | 90% |
| **维护能力** | ✅ Maintain | ✅ 索引同步+陈旧检测 | 85% |
| **元数据追踪** | ❌ 无 | ✅ 完整frontmatter | **超越CE** |
| **原文保留** | ❌ 无 | ✅ source-materials | **超越CE** |

**总体对齐度：90%+**

---

## 十一、规则驱动架构（v2.1 新增）

### 11.1 设计理念

**核心原则**：业务规则与代码分离

```
规则文件（Markdown） → 规则引擎 → 执行代码
     ↑                                    ↓
   用户编辑                            系统行为
```

**优势**：
- ✅ 用户修改规则 → 编辑 MD 文件
- ✅ 不需要懂 TypeScript
- ✅ 不需要重新编译
- ✅ 规则版本控制友好

---

### 11.2 规则文件位置

所有业务规则存储在：
```
skills/material-ingest/references/
├── classification-rules.md    ← 内容分类规则
├── routing-rules.md           ← 层级路由规则
├── stopwords.txt              ← 停用词列表
└── templates/                 ← 模板定义
    ├── meeting-notes.md
    ├── user-feedback.md
    ├── prd.md
    ├── decision-record.md
    ├── technical-spec.md
    ├── seven-sections.md
    └── README.md
```

---

### 11.3 修改分类规则

**需求**：让"周报"也识别为会议记录

**操作步骤**：
1. 打开 `skills/material-ingest/references/classification-rules.md`
2. 找到 `### 1. MEETING_NOTE（会议记录）`
3. 在关键词列表中添加"周报"

```markdown
### 1. MEETING_NOTE（会议记录）

**关键词**：
- 中文: 会议, 纪要, 讨论会, 站会, 周会, 月会, kick-off, 周报  ← 添加这个
```

4. 保存文件
5. 重启应用（规则引擎会重新加载）

**无需修改任何代码！**

---

### 11.4 修改路由规则

**需求**：让技术规格文档路由到 workspace

**操作步骤**：
1. 打开 `skills/material-ingest/references/routing-rules.md`
2. 在合适位置添加新规则

```markdown
### 规则 7：技术规格 → workspace

**优先级**: 7
**目标层级**: workspace
**需要确认**: false

**触发条件**：
- 内容类型 = TECHNICAL_SPEC
- task_goal 包含: "架构设计", "技术方案"

**理由**: 技术规格文档需要团队协作
```

3. 保存文件
4. 重启应用

---

### 11.5 修改模板

**需求**：为会议记录模板添加新章节"参考资料"

**操作步骤**：
1. 打开 `skills/material-ingest/references/templates/meeting-notes.md`
2. 添加新章节

```markdown
## 参考资料

相关文档和链接
```

3. 保存文件
4. 重启应用

---

### 11.6 修改停用词

**需求**：添加"讨论"到停用词

**操作步骤**：
1. 打开 `skills/material-ingest/references/stopwords.txt`
2. 在中文停用词部分添加

```
讨论
```

3. 保存文件
4. 重启应用

---

### 11.7 规则引擎工作原理

**加载流程**：
```
应用启动
  ↓
规则引擎初始化
  ↓
读取 classification-rules.md → 解析为规则对象
读取 routing-rules.md → 解析为规则对象
读取 templates/*.md → 解析为模板对象
读取 stopwords.txt → 解析为停用词集合
  ↓
规则加载完成
  ↓
运行时调用规则引擎执行规则
```

**执行流程**：
```
材料输入
  ↓
classifyContent() → 规则引擎.executeClassification()
  ↓
routeToLayer() → 规则引擎.executeRouting()
  ↓
selectTemplate() → 规则引擎.getTemplate()
  ↓
输出结果
```

---

### 11.8 规则文件格式

#### **分类规则格式**

```markdown
### N. TYPE_NAME（描述）

**触发条件**：
- source_type 精确匹配: `VALUE1`, `VALUE2`
- 文件名包含关键词

**关键词**：
- 中文: 关键词1, 关键词2
- 英文: keyword1, keyword2

**置信度**: high | medium | low
**优先级**: N
```

#### **路由规则格式**

```markdown
### 规则 N：描述 → 目标层级

**优先级**: N
**目标层级**: drafts | workspace | context
**需要确认**: true | false

**触发条件**：
- 条件1
- 条件2

**理由**: 说明文字
```

#### **模板格式**

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

### 11.9 常见问题

#### **Q: 修改规则后为什么没生效？**
A: 需要重启应用。规则引擎在启动时加载规则文件。

#### **Q: 可以动态重新加载规则吗？**
A: 暂不支持。需要重启应用。

#### **Q: 规则文件语法错误会怎样？**
A: 规则引擎会跳过该规则并继续加载其他规则。检查控制台警告信息。

#### **Q: 可以添加自定义模板吗？**
A: 可以！在 `templates/` 目录创建新的 MD 文件，并在 `classification-rules.md` 中添加对应的内容类型。

#### **Q: 如何测试新规则？**
A: 修改规则文件后，运行测试脚本验证行为是否符合预期。

---

### 11.10 最佳实践

1. **规则版本控制**
   - 规则文件使用 Git 管理
   - 重要修改提交时注释说明

2. **规则命名清晰**
   - 使用描述性的规则名称
   - 添加详细的说明文字

3. **优先级合理**
   - 更具体的规则优先级更高（数字更小）
   - 通用规则优先级更低

4. **测试验证**
   - 修改规则后进行测试
   - 确保不影响现有功能

5. **文档同步**
   - 规则文件中的说明保持更新
   - 与实际行为保持一致

---

## 十二、最佳实践

### 11.1 日常使用

**默认模式（推荐）**：
- 保持默认配置，所有材料到 drafts
- 索引自动更新
- 使用 7 章节模板
- 人工确认后提升到 workspace

**高级模式**（适合熟练用户）：
- 启用智能路由：自动分流到 drafts/workspace
- 启用语义匹配：自动合并相关主题
- 启用灵活模板：根据内容类型选择模板

### 11.2 定期维护

**每周维护**：
```bash
# 执行维护检查
npx tsx scripts/lib/maintain-check.ts

# 自动修复索引问题
npx tsx scripts/lib/maintain-fix.ts
```

**每月审查**：
- 检查 drafts 中超过 30 天的内容
- 检查 workspace 中超过 90 天的内容
- 提升成熟内容到 context

### 11.3 性能优化

**大量文件时**：
- 启用语义匹配可能较慢
- 可以调高相似度阈值（0.7 → 0.8）
- 考虑定期归档旧文件

---

## 十二、故障排查

### 问题 1：索引未更新

**症状**：新文件未出现在 CLAUDE.md 中

**解决**：
```bash
# 手动触发索引更新
npx tsx scripts/lib/maintain-fix.ts
```

### 问题 2：文件命名不符合预期

**症状**：生成的文件名包含"整理一下"等口语词

**解决**：
- 检查 `cleanTopicFromGoal()` 规则
- 提交 issue 或 PR 增加清洗规则

### 问题 3：错误的层级路由

**症状**：材料被路由到错误的层级

**解决**：
- 检查是否启用了智能路由
- 如果不需要智能路由，保持默认配置
- 人工移动文件并更新索引

---

## 附录：快速参考

### A. 文件命名模式

```
会议记录：      {date}-{topic}.md
需求文档：      需求整理.md
用户反馈：      用户反馈汇总.md
决策记录：      {date}-决策-{topic}.md
技术规格：      技术规格.md
```

### B. 配置快速切换

```typescript
// 默认（保守）
const config = DEFAULT_CONFIG;

// 推荐（智能）
const config = RECOMMENDED_CONFIG;

// 自定义
const config = {
  routing: { enable_smart_routing: true },
  template: { enable_flexible_template: true },
  file_decision: { enable_semantic_match: false }
};
```

### C. 维护命令

```bash
# 检查
performMaintenance(workspaceRoot)

# 修复
autoFixIndexSync(workspaceRoot)

# 报告
formatMaintenanceReport(report)
```

---

**文档版本**：2.1.0  
**最后更新**：2026-08-25  
**实现状态**：✅ 完整实现  
**架构模式**：✅ 规则驱动  
**测试状态**：✅ 全部通过
