# context-workspace 目录组织规则

> 版本：1.0.0  
> 更新：2026-08-25  
> 参考：context-engineer 设计原则

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

### 1.3 三层生命周期模型

```
drafts/      → 低可信度，正在形成的想法
  ↓ 人工确认
workspace/   → 中可信度，正在进行的工作
  ↓ 人工确认
context/     → 高可信度，已确认的知识
```

**关键规则**：
1. **不自动提升**：从 drafts → workspace 需要人工判断
2. **When in doubt, drafts**：不确定时默认放 drafts
3. **错误代价不对称**：放错到 context 比放错到 drafts 危害更大

---

## 二、目录结构

### 2.1 标准结构

```
context-workspace/
├── CLAUDE.md                    ← 根索引（待实现）
├── drafts/                      ← 原始材料，低可信度
│   └── {project_id}/
│       ├── 需求整理.md          ← 持久性内容，追加更新
│       ├── 用户反馈汇总.md      ← 用户反馈汇总
│       ├── 2026-08-20-会议.md   ← 时间性内容，独立记录
│       └── .source-materials/   ← 原文归档（隐藏目录）
│           ├── {task_id_1}/
│           │   └── materials.md
│           └── {task_id_2}/
│               └── materials.md
├── workspace/                   ← 进行中的工作，中可信度
│   ├── projects/
│   │   └── {project_id}/
│   │       ├── CLAUDE.md        ← 项目索引（待实现）
│   │       └── materials/
│   │           ├── 需求整理.md  ← 从 drafts 提升
│   │           └── meeting-notes/
│   │               └── 2026-08-20-kickoff.md
│   ├── prd/                     ← PRD 文档
│   │   └── {project_id}-{task_id}.md
│   ├── decisions/               ← 决策记录
│   │   └── {project_id}/
│   └── reports/                 ← 分析报告
│       └── change-impact-*.json
└── context/                     ← 已确认知识，高可信度
    └── {project_id}/
        ├── product-overview.md
        └── terminology.md
```

### 2.2 子目录创建规则

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

## 三、文件命名规则

### 3.1 内容分类

| 内容类型 | 特征 | 文件名模式 | 示例 |
|---------|------|-----------|------|
| **会议记录** | 包含"会议"、"meeting"、"纪要" | `{date}-{topic}.md` | `2026-08-20-需求讨论会.md` |
| **需求材料** | 需求、功能、产品文档 | `需求整理.md` | `需求整理.md` |
| **用户反馈** | 用户反馈、客服反馈 | `用户反馈汇总.md` | `用户反馈汇总.md` |
| **决策记录** | 关键决策、讨论结论 | `{date}-决策-{topic}.md` | `2026-08-20-决策-优先级.md` |
| **技术规格** | 技术文档、架构设计 | `技术规格.md` | `技术规格.md` |

### 3.2 主题提取优先级

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

### 3.3 日期提取优先级

```
1. 从 source_time 提取（最可靠）
   source_time: "2026-08-20T10:00:00Z" → "2026-08-20"

2. 从 material.name 中提取日期模式
   - "2026-08-20-会议记录.md" → "2026-08-20"
   - "2026年8月20日会议.md" → "2026-08-20"

3. 使用当前日期
   new Date().toISOString().split('T')[0]
```

---

## 四、文件操作规则

### 4.1 创建 vs 追加决策

```
生成文件名
  ↓
检查目标目录是否存在同名文件？
  ├─ 否 → 创建新文件
  └─ 是 ↓
      是时间性内容（会议记录/决策记录）？
      ├─ 是 → 创建新文件（不追加）
      └─ 否 ↓
          检查最后修改时间
          ├─ < 7 天 → 追加到现有文件
          └─ ≥ 7 天 → 创建新文件
```

**7 天规则说明**：
- 7 天内的材料视为同一轮需求的延续，应该追加
- 超过 7 天可能是新一轮需求，应该创建新文件
- 会议记录永远独立，不追加

### 4.2 文件冲突处理

当文件名冲突时（同一天多次会议，主题相同）：

```
2026-08-20-需求讨论.md       ← 第一次
2026-08-20-需求讨论-2.md     ← 第二次（自动添加序号）
2026-08-20-需求讨论-3.md     ← 第三次
```

---

## 五、元数据管理

### 5.1 Frontmatter 结构

每个文件都应该包含 frontmatter：

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
  - repo://context-workspace/drafts/{project_id}/.source-materials/{task_id}/materials.md
---
```

### 5.2 版本管理

**版本号格式**：语义化版本 `{major}.{minor}.{patch}`

**递增规则**：
- 创建新文件：`0.1.0`
- 追加内容：递增 patch 版本（`0.1.0` → `0.1.1` → `0.1.2`）
- 重大更新：递增 minor 版本（`0.1.x` → `0.2.0`）

### 5.3 task_history 追踪

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

## 六、工作流程

### 6.1 材料摄入流程

```
用户提交材料
  ↓
1. 内容分类
   - 分析 source_type 和 material.name
   - 判断是会议记录、需求文档、用户反馈等
  ↓
2. 生成文件名
   - 提取日期（如果是时间性内容）
   - 提取主题
   - 应用命名规则
  ↓
3. 决策文件操作
   - 检查是否存在同名文件
   - 根据内容类型和时间间隔决定创建/追加
  ↓
4. 写入文件
   - 创建模式：生成新文件，初始化 frontmatter
   - 追加模式：更新 frontmatter，追加增量章节
  ↓
5. 归档原文
   - 将原始材料保存到 .source-materials/{task_id}/
  ↓
6. 更新索引（待实现）
   - 更新项目 CLAUDE.md
   - 更新根 CLAUDE.md
```

### 6.2 生命周期提升

```
drafts/ 中的材料
  ↓
人工确认：是否准备好进入 workspace？
  ├─ 否 → 继续在 drafts/
  └─ 是 ↓
      复制到 workspace/projects/{project_id}/materials/
      ↓
      人工确认：是否已验证为稳定知识？
      ├─ 否 → 继续在 workspace/
      └─ 是 ↓
          经过 CP-C01 确认点
          ↓
          提升到 context/{project_id}/
```

---

## 七、索引文件（待实现）

### 7.1 根索引（context-workspace/CLAUDE.md）

```markdown
# Context Workspace - 项目材料工作区

## 目录结构

| 目录 | 用途 | 说明 |
|------|------|------|
| `context/` | 已确认的知识 | 产品功能、公司事实、行业标准 |
| `workspace/` | 进行中的工作 | PRD、活跃的任务、项目材料 |
| `drafts/` | 正在形成的想法 | 原始材料、会议记录、探索 |

## 工作流

drafts/ → workspace/ → context/

## 当前项目

- [knowledge-qa-assistant](workspace/projects/knowledge-qa-assistant/CLAUDE.md)
- [prd-review-agent](workspace/projects/prd-review-agent/CLAUDE.md)
```

### 7.2 项目索引（workspace/projects/{project_id}/CLAUDE.md）

```markdown
# {项目名称} - 项目材料

## 项目概况

- **项目 ID**: {project_id}
- **创建时间**: {created_at}
- **最后更新**: {updated_at}

## 文件导航

### 核心材料
- [需求整理.md](materials/需求整理.md) — 项目需求汇总

### 会议记录
- [2026-08-20-kickoff.md](materials/meeting-notes/2026-08-20-kickoff.md)
```

---

## 八、典型场景

### 场景 1：首次提交需求材料

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 需求讨论文档
- task_goal: "整理知识库问答助手需求"

**输出**：
```
drafts/knowledge-qa-assistant/
├── 需求整理.md          ← 新建文件
└── .source-materials/
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
├── 需求整理.md          ← 追加内容，version: 0.1.0 → 0.1.1
└── .source-materials/
    ├── agent-1787559564133/
    └── agent-1787559302652/  ← 新增
```

### 场景 3：提交会议记录

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 会议记录
- task_goal: "记录kickoff会议"
- source_time: "2026-08-20"

**输出**：
```
drafts/knowledge-qa-assistant/
├── 需求整理.md
├── 2026-08-20-kickoff会议.md  ← 新建独立文件
└── .source-materials/
    └── ...
```

### 场景 4：同一天第二次会议

**输入**：
- project_id: `knowledge-qa-assistant`
- materials: 会议记录
- task_goal: "记录需求评审会议"
- source_time: "2026-08-20"

**输出**：
```
drafts/knowledge-qa-assistant/
├── 需求整理.md
├── 2026-08-20-kickoff会议.md
├── 2026-08-20-需求评审会议.md  ← 新建独立文件（主题不同）
└── .source-materials/
    └── ...
```

---

## 九、注意事项

### 9.1 禁止行为

❌ **不要预先创建空目录**
```
# 错误
mkdir context/features
mkdir context/customers
# 应该等有内容时再创建
```

❌ **不要使用 task_id 作为文件名**
```
# 错误
agent-1787559564133.md
# 正确
需求整理.md
```

❌ **不要自动提升层级**
```
# 错误：自动从 drafts 复制到 context
# 正确：必须经过人工确认和 CP-C01
```

### 9.2 推荐做法

✅ **保持文件名简洁清晰**
```
需求整理.md
用户反馈汇总.md
2026-08-20-kickoff会议.md
```

✅ **及时更新 frontmatter**
```yaml
version: 0.1.1  # 每次追加递增
updated_at: 2026-08-22T14:30:00Z
```

✅ **原文归档到隐藏目录**
```
.source-materials/  # 加 . 前缀，用户不常访问
```

---

## 十、实现状态

### ✅ 已实现

1. **文件命名系统** (`scripts/lib/file-naming.ts`)
   - 智能内容分类
   - 主题和日期提取
   - 文件冲突处理

2. **追加逻辑** (`scripts/agent/structured-material.ts`)
   - 创建/追加模式支持
   - Frontmatter 元数据管理
   - 版本号自动递增

3. **集成改造** (`scripts/agent/workspace-provider.ts`)
   - 使用新命名规则
   - 7天决策引擎
   - 写入到正确路径

### ⏭️ 待实现

1. **索引文件生成**
   - 根索引（context-workspace/CLAUDE.md）
   - 项目索引（workspace/projects/{project_id}/CLAUDE.md）
   - 自动维护文件列表

2. **目录优化**
   - 将 `source-materials/` 改为 `.source-materials/`

3. **Maintain 能力**
   - 索引同步
   - 孤立文件检测
   - 死链检查

4. **数据迁移**
   - 重命名现有 `agent-*.md` 文件
   - 合并同项目的多个文件

---

- **核心原则**: 内容优先、用户可读、智能合并、生命周期管理
- **实现代码**: `scripts/lib/file-naming.ts`, `scripts/agent/structured-material.ts`

---


