# context-engineer Skill 的文件内容整理逻辑

> 基于 https://github.com/LeeFinn2025/context-engineer.git 完整分析

---

## 一、核心设计哲学

### 1. 公式

```
Instruction + Context = Input → Output
```

- **Instruction**：一次性、可丢弃
- **Context**：可重用资产，决定输出质量
- **目标**：将 Context 作为工程对象，带结构、版本、质量标准、生命周期管理

### 2. 三层架构（生命周期模型）

```
drafts/      → 想法正在形成（what we're THINKING）
   ↓ promote
workspace/   → 正在进行的工作（what we're DOING）
   ↓ promote
context/     → 已确认的知识（what IS）
```

**核心原则**：
- **不自动提升**：层级间流动需要人工判断
- **When in doubt, drafts**：不确定时默认放 drafts（放错到 context 比放错到 drafts 危害更大）
- **生命周期**：drafts 是短期的（days-weeks），workspace 是中期的（weeks-months），context 是长期的（months-years）

---

## 二、六大核心能力

### 1. Bootstrap（初始化）

**触发时机**：用户第一次建立 Context 仓库

**流程**：

```
① 环境检测
   - 检测 .claude/ → Claude Code
   - 检测 .cursor/ → Cursor
   - 检测 .windsurfrules → Windsurf
   - 检查是否 git 仓库
   ↓
② 访谈（5-8 个问题）
   Q1: 你做什么？→ 决定仓库分类结构
   Q2: 你的产品/公司做什么？→ context/product-overview.md
   Q3: 你们的术语/行话？→ context/terminology.md
   Q4: 你目前在做什么？→ workspace/{project}.md
   Q5: 你经常需要反复解释什么？→ 额外的 context 文档
   自适应问题：
   - 管理团队？→ context/team.md
   - 有竞争对手？→ context/competitors.md
   - 有标准/法规？→ context/standards.md
   ↓
③ 目录脚手架（最小可行结构）
   {repo-root}/
   ├── context/
   │   ├── CLAUDE.md              ← 索引
   │   ├── product-overview.md    ← 从访谈生成
   │   └── terminology.md         ← 从访谈生成
   ├── workspace/
   │   ├── CLAUDE.md
   │   └── {current-project}.md   ← 从访谈生成
   ├── drafts/
   │   └── CLAUDE.md
   └── CLAUDE.md                   ← 根索引
   ↓
④ 种子内容生成
   - 使用用户的原话（不改写成企业术语）
   - 简洁（30-100 行）
   - 明确标记空白：[TODO: 补充 X 的细节]
   ↓
⑤ 索引生成
   - 每个目录一个 CLAUDE.md
   - 包含：描述、目录映射、规则、文件摘要
   ↓
⑥ 交接说明
   - 列出创建的所有文件
   - 建议下一步最有价值的文档
   - 日常使用指南
```

**关键原则**：
- ❌ 不预先创建空目录
- ❌ 不生成通用内容（必须使用用户的具体案例和原话）
- ✅ 每个目录至少 1-2 个真实内容文件
- ✅ 子目录延迟创建（只有积累 7+ 个相似主题文件时才创建）

---

### 2. Ingest（摄入内容）

**触发时机**：用户提供新材料（会议记录、用户反馈、产品文档等）

**决策流程**：

```
用户输入
   ↓
步骤 1: 内容分类
   - 是会议记录？用户反馈？产品文档？决策记录？
   - 分析 source_type 和 content 特征
   ↓
步骤 2: 目录路由（决定放在哪一层）
   ├─ 原始想法/未确认 → drafts/
   ├─ 正在进行的工作 → workspace/
   └─ 已确认的知识 → context/
   ↓
步骤 3: 文件决策（关键！）
   同名文件已存在？
   ├─ 否 → 创建新文件
   └─ 是 ↓
       是时间性内容（会议记录/每日站会）？
       ├─ 是 → 创建新文件（每次独立）
       └─ 否 ↓
           距上次修改 < 某阈值（如 7 天）？
           ├─ 是 → 追加到现有文件
           └─ 否 → 创建新文件或询问用户
   ↓
步骤 4: 格式化 & 写入
   - 使用合适的模板（见 templates.md）
   - 保留原始内容的语言和风格
   - 添加元数据（日期、来源、状态等）
   ↓
步骤 5: 索引更新
   - 更新所在目录的 CLAUDE.md
   - 添加文件名和一行摘要
   ↓
步骤 6: 确认
   - 告诉用户做了什么
   - 指出文件路径
```

**文件命名规则**：

| 内容类型 | 命名规则 | 示例 | 说明 |
|---------|---------|------|------|
| **会议记录** | `{date}-{topic}.md` | `2024-03-15-sprint-planning.md` | 时间性内容，每次独立 |
| **决策记录** | `{date}-{topic}.md` | `2024-03-15-api-framework.md` | 时间性内容 |
| **产品文档** | `{topic}.md` | `authentication.md` | 持久性内容，可追加 |
| **用户反馈** | `user-feedback.md` | `user-feedback.md` | 持久性内容，追加汇总 |
| **PRD** | `{feature-name}.md` | `payment-gateway.md` | 持久性内容，状态演进 |

**关键判断**：
- **时间性内容**（temporal）：每次独立成文件，按日期命名
  - 会议记录、每日站会、事件报告、周报
- **持久性内容**（persistent）：同主题追加更新，按主题命名
  - 产品功能文档、术语表、用户反馈汇总、技术规格

---

### 3. Maintain（维护）

**触发时机**：定期维护或用户请求

**维护检查清单**：

```
① 索引同步
   - 遍历所有目录
   - 检查文件列表是否与索引一致
   - 添加缺失的文件到索引
   - 移除不存在的文件
   - 检查死链
   ↓
② 孤立文件检测
   - 查找未在任何索引中列出的文件
   - 建议是删除、归档还是添加索引
   ↓
③ 陈旧内容检测
   - 查找长时间未更新的文件
   - workspace/ 中超过 3 个月的任务 → 建议归档或提升
   - drafts/ 中超过 1 个月的草稿 → 建议推进或删除
   ↓
④ 重复内容检测
   - 查找标题相似或内容重叠的文件
   - 建议合并或明确区分
   ↓
⑤ 格式一致性
   - 检查 frontmatter 格式
   - 检查标题层级
   - 检查链接格式
```

---

### 4. Evolve（演进）

**触发时机**：项目完成、知识成熟时

**生命周期提升逻辑**：

```
drafts/ 中的内容
   ↓
检查：这个想法是否已经变成具体工作？
   ├─ 是 → 提升到 workspace/
   │       - 创建正式的项目文档
   │       - 添加状态、所有者、时间线
   │       - 可以删除或保留 drafts/ 中的原稿
   └─ 否 → 继续在 drafts/

workspace/ 中的内容
   ↓
检查：这个项目/任务是否已完成？产出的知识是否稳定？
   ├─ 是 → 提升到 context/
   │       - 提取永久性知识（业务规则、功能说明、决策）
   │       - 创建或更新 context/ 中的文档
   │       - workspace/ 中的文档可以归档或删除
   └─ 否 → 继续在workspace/

context/ 中的内容
   ↓
检查：这个知识是否过期或被替代？
   ├─ 是 → 标记为 superseded 或删除
   │       - 如果有历史价值，添加"已废弃"标记
   │       - 指向新的替代文档
   └─ 否 → 继续保留
```

**提升建议的触发条件**：
- drafts/ 中文件存在 > 7 天 → "这个想法是否该推进了？"
- workspace/ 中状态 = "Shipped" → "项目已完成，是否提取知识到 context？"
- workspace/ 中文件未更新 > 3 个月 → "这个任务是否已完成或放弃？"

---

### 5. Review（审查）

**触发时机**：定期审查或重大更新前

**审查维度**：

```
① 完整性
   - 核心概念是否都有文档？
   - 新员工/新 AI 是否能理解业务？
   - 缺少哪些关键文档？
   ↓
② 准确性
   - 信息是否与当前状态一致？
   - 是否有过期内容？
   - 是否需要更新？
   ↓
③ 可用性
   - 文档是否易于查找？
   - 索引是否清晰？
   - 是否需要重组？
   ↓
④ 质量
   - 内容是否具体（不是泛泛而谈）？
   - 是否有实际例子？
   - 是否过于冗长或过于简略？
```

**输出**：
- 待更新文档清单
- 缺失文档建议
- 重组建议

---

### 6. Organize（重组）

**触发时机**：目录混乱、文件过多、用户明确请求

**重组原则**：

```
① 触发条件
   - 某个目录有 7+ 个相似主题的文件 → 创建子目录
   - 文件命名不一致 → 标准化
   - 层级错误（drafts 放了稳定知识）→ 重新分类
   ↓
② 重组操作
   - 创建子目录
   - 移动文件
   - 更新所有引用链接
   - 更新索引文件
   ↓
③ 验证
   - 检查所有链接是否仍然有效
   - 确认索引已更新
   - 运行完整性检查
```

**子目录创建规则**：

```
# 错误：预先创建空结构
context/
├── 01_product/
├── 02_features/
├── 03_customers/
└── 04_competitors/
(全是空的)

# 正确：有机生长
context/
├── product-overview.md          ← 开始只有这些
├── terminology.md
├── feature-auth.md
├── feature-payments.md
├── feature-notifications.md
... 积累到 7+ 个 feature 文档后 ...
context/
├── product-overview.md
├── terminology.md
└── features/                     ← 现在才创建子目录
    ├── auth.md
    ├── payments.md
    ├── notifications.md
    └── ...
```

---

## 三、文件模板体系

### Context 层模板（已确认知识）

#### 1. Product Overview
```markdown
# {Product Name}

## What We Do
{核心价值主张，1-3 句话}

## Who It's For
{目标用户/客户}

## Core Problem
{解决的问题}

## How It Works
{高层产品描述}

## Key Metrics
{成功指标}
```

#### 2. Terminology
```markdown
# Terminology

| Term | Definition | Notes |
|------|-----------|-------|
| | | |
```

#### 3. Feature Documentation
```markdown
# {Feature Name}

## What It Does
{功能目的和价值}

## How It Works
{用户面向的行为}

## Key Rules & Constraints
{业务规则、边界情况}

## Dependencies
{依赖的其他功能/系统}
```

### Workspace 层模板（进行中的工作）

#### 1. PRD
```markdown
# {Feature Name}

**Status**: Draft / In Review / Approved / In Development / Shipped
**Owner**: {name}
**Updated**: {date}

## Background
{为什么做}

## Goal
{成功标准}

## Scope
{范围内和明确排除的}

## Design
{如何工作}

## Open Questions
{待解决的问题}
```

#### 2. Meeting Notes
```markdown
# {Meeting Topic}

**Date**: {YYYY-MM-DD}
**Attendees**: {names}

## Key Discussions
- {topic 1}: {讨论内容、决策}

## Action Items
- [ ] {action} — {owner} — {deadline}

## Context for AI
{未在会议中明说但理解笔记需要的背景}
```

#### 3. Decision Record
```markdown
# {Decision Topic}

**Date**: {YYYY-MM-DD}
**Status**: Proposed / Decided / Superseded
**Decision**: {一句话总结}

## Context
{为什么需要这个决策}

## Options Considered
1. **{Option A}**: {优缺点}
2. **{Option B}**: {优缺点}

## Decision & Rationale
{选择了什么，为什么}

## Consequences
{这个决策的影响}
```

### Drafts 层模板（原始想法）

#### 1. Quick Note
```markdown
# {Topic}

**Date**: {YYYY-MM-DD}

{直接写下来，不需要结构}
```

#### 2. Exploration
```markdown
# {Topic} — Exploration

**Date**: {YYYY-MM-DD}
**Status**: Exploring / Concluded / Abandoned

## Question
{我们想搞清楚什么？}

## Findings
{目前学到的}

## Next Steps
{下一步：提升到 workspace？继续研究？放弃？}
```

---

## 四、索引文件系统

### 根索引（CLAUDE.md）

```markdown
# {Repo Name} — Context Repository

{一句话描述}

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| `context/` | 已确认知识 |
| `workspace/` | 进行中的工作 |
| `drafts/` | 原始材料 |

## How It Works

- Documents flow: drafts/ → workspace/ → context/
- context/ = truth (what IS)
- workspace/ = plans (what we're DOING)
- drafts/ = ideas (what we're THINKING)

## Contents

### context/
- **product-overview.md** — {摘要}

### workspace/
- **{file}.md** — {摘要}

### drafts/
{列出文件}
```

**关键**：
- 每个目录一个索引文件
- 索引必须与实际文件同步（Maintain 能力负责）
- 索引是 AI 导航的"神经系统"：未索引的文件对 AI 不可见

---

## 五、核心反模式（Anti-Patterns）

### ❌ 不要做

1. **预先创建空结构**
   ```
   # 错误
   mkdir context/01_product context/02_features ...
   ```

2. **生成通用内容**
   ```
   # 错误：AI 生成的通用描述
   "我们提供创新的解决方案..."
   # 正确：用户的原话
   "我们帮助餐厅老板自动化库存管理"
   ```

3. **过度结构化**
   ```
   # 错误：只有 3 个文件就搞复杂层级
   context/01_product/01_overview/01_vision.md
   # 正确：扁平化
   context/product-overview.md
   ```

4. **自动提升层级**
   ```
   # 错误：自动从 drafts 复制到 context
   # 正确：必须人工判断后手动提升
   ```

5. **忽略用户的语言**
   ```
   # 错误：将中文材料翻译成英文（用户习惯中文）
   # 正确：使用用户工作语言
   ```

### ✅ 应该做

1. **内容优先于结构**
   - 先写内容，结构自然演化

2. **使用用户的原话**
   - 保留特定术语、案例、风格

3. **明确标记空白**
   - `[TODO: 补充定价模型]` 而非编造

4. **延迟子目录创建**
   - 7+ 文件后才考虑分组

5. **保持索引同步**
   - 每次文件操作后更新索引

---

## 六、与当前项目的对比

| 维度 | context-engineer | 当前项目 |
|------|------------------|---------|
| **Bootstrap** | 访谈驱动，生成种子文档 | 无（用户直接提供材料） |
| **Ingest** | 手动判断分类和路由 | 自动分类 + 7天追加规则 |
| **文件命名** | 手动起名，强调可读 | 自动生成（`cleanTopicFromGoal`） |
| **追加逻辑** | 隐式（由 AI 判断） | 显式（`decideFileAction`） |
| **索引系统** | 每个目录有 CLAUDE.md | 待实现 |
| **Maintain** | 显式能力 | 待实现 |
| **Evolve** | 显式能力（生命周期提升） | CP-C01 确认点 |

---

## 七、总结

**context-engineer 的核心逻辑**：

1. **Bootstrap**：通过访谈生成最小可行结构（3 层 + 3-5 个种子文档）
2. **Ingest**：分类内容 → 路由到层级 → 决定创建/追加 → 格式化写入 → 更新索引
3. **Maintain**：同步索引、检测孤立文件、标记陈旧内容
4. **Evolve**：根据生命周期提升内容（drafts → workspace → context）
5. **Review**：审查完整性、准确性、可用性
6. **Organize**：延迟创建子目录（7+ 文件规则）

**哲学**：
- 内容优先于结构
- 有机生长而非预先规划
- 用户原话而非通用内容
- 明确生命周期而非随意放置
- 索引是神经系统而非装饰品
