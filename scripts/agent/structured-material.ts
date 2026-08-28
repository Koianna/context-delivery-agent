import * as fs from "node:fs";
import * as path from "node:path";
import type { MaterialIngestInput, MaterialIngestOutput, MaterialInput } from "../lib/context-types.js";
import { readMaterialContent } from "../lib/material-bundle.js";
import { parseFrontmatter, pathToRepoRef, writeTextAtomic, renderFrontmatter, incrementPatch } from "../lib/repository.js";

interface MaterialSegment {
  speaker: string | null;
  content: string;
}

interface UserFeedbackEntry {
  userId: string | null;
  time: string | null;
  content: string;
}

interface HeadingInfo {
  isHeading: boolean;
  level: number;  // 1=一级, 2=二级, 3=三级
  text: string;   // 清理后的标题文本
}

interface CatalogEntry {
  title: string;       // "### 核心指标" 里的标题文本，如 "核心指标"
  materialName: string;
  lines: string[];     // 结构化 markdown 行（#### 子标题 / - 列表项）
}

// 材料被识别为"结构化清单类"时，尾部关键词优先作为三级标题名
const CATALOG_TITLE_SUFFIXES = [
  "核心指标", "关键指标", "指标",
  "产品边界", "业务边界", "边界",
  "核心价值", "价值",
  "验收标准", "标准", "规范",
  "业务规则", "规则",
  "清单", "列表", "范围", "目标",
  "原则",
];

// source_type 判定为清单类的关键词（大小写不敏感）
const CATALOG_SOURCE_TYPE_KEYWORDS = /product_requirement|product_doc|business_rule|indicator|catalog|boundary/i;

// name 判定为清单类的关键词
const CATALOG_NAME_KEYWORDS = /指标|边界|清单|列表|规则|规范|范围|目标|原则|标准/;

export function writeStructuredMaterial(
  input: MaterialIngestInput,
  _output: MaterialIngestOutput,
  targetPath: string,
  root: string,
  artifactRef = pathToRepoRef(targetPath, root),
  mode: 'create' | 'append' = 'create',
  taskId?: string,
): string {
  // 如果是追加模式且文件存在
  if (mode === 'append' && fs.existsSync(targetPath)) {
    return appendToStructuredMaterial(input, _output, targetPath, root, artifactRef, taskId);
  }

  // 创建新文件
  const isMeeting = input.materials.some((material) =>
    /MEETING|会议|纪要|记录/i.test(`${material.source_type} ${material.name}`)
  );
  const title = isMeeting ? "会议记录整理稿" : "结构化材料整理稿";

  const sections = new Map<string, string[]>();
  for (const key of ["背景与事实", "用户反馈", "观点与方案", "已确认决策", "行动项与分工", "风险与待确认", "来源材料"]) {
    sections.set(key, []);
  }

  const catalogEntries: CatalogEntry[] = [];

  for (const [index, material] of input.materials.entries()) {
    const content = readMaterialContent(material, root);
    if (isUserFeedbackMaterial(material)) {
      const feedback = parseUserFeedbackEntries(content, material.source_owner);
      sections.get("用户反馈")?.push(...feedback.map(formatUserFeedback));
      sections.get("来源材料")?.push(formatSourceMaterial(material, index, content, artifactRef));
      continue;
    }

    // 清单类材料：整份透传到"补充材料"section，不做强制归类
    if (isCatalogMaterial(material, content)) {
      catalogEntries.push({
        title: extractCatalogTitle(material.name),
        materialName: material.name,
        lines: renderCatalogMaterialLines(content),
      });
      sections.get("来源材料")?.push(formatSourceMaterial(material, index, content, artifactRef));
      continue;
    }

    const segments = parseMaterialSegments(content, isMeeting);

    for (const segment of segments) {
      const category = classifySegment(segment);
      const entry = summarizeSegment(segment, category);
      sections.get(category)?.push(entry);
    }

    sections.get("来源材料")?.push(formatSourceMaterial(material, index, content, artifactRef));
  }

  const bodyContent = [
    `# ${title}`,
    "",
    "> 本文件由项目 Runtime 生成。内容只对原始材料做结构化整理，不把用户反馈自动升级为产品需求，也不替代人工决策。",
    "",
    `- 任务目标：${input.task_goal}`,
    `- 材料数量：${input.materials.length}`,
    `- 产物引用：${artifactRef}`,
    "",
    "## 归纳摘要",
    "",
    `- 本次材料按${isMeeting ? "会议内容" : "材料内容"}切分为独立信息单元，再按事实、反馈、方案、决策、行动项和风险进行归类。`,
    "- 用户反馈、方案建议和待确认事项不会自动升级为稳定业务事实或产品需求。",
    "",
    ...[...sections.entries()].flatMap(([heading, lines]) => {
      // "来源材料"延后到"补充材料"之后再输出
      if (heading === "来源材料") return [];

      const result = [`## ${heading}`, ""];

      if (!lines.length) {
        result.push("- 未从原文识别到明确内容，需人工补充。", "");
        return result;
      }

      for (const line of unique(lines)) {
        const headingInfo = detectHeading(line);
        if (headingInfo.isHeading) {
          // 渲染为标题（## 已占用，从 ### 开始）
          const prefix = '#'.repeat(headingInfo.level + 2);
          result.push("", `${prefix} ${headingInfo.text}`, "");
        } else {
          // 渲染为列表项
          result.push(`- ${line}`);
        }
      }

      result.push("");
      return result;
    }),
    ...renderCatalogSection(catalogEntries),
    ...renderSourceMaterialSection(sections.get("来源材料") ?? []),
    "## 原文保留说明",
    "",
    "原始材料已由 Runtime 登记到 `context-workspace/drafts/`，本整理稿不替换原文。",
    "",
  ].join("\n");

  // 添加 frontmatter
  const metadata: Record<string, string | string[] | null> = {
    artifact_id: `${input.project_id || input.workspace_slug || 'default'}-materials`,
    version: '0.1.0',
    project_id: input.project_id || input.workspace_slug || 'default-project',
    content_type: isMeeting ? 'MEETING_NOTE' : 'GENERAL',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    task_history: taskId ? [
      JSON.stringify({
        task_id: taskId,
        updated_at: new Date().toISOString(),
        material_count: input.materials.length,
        summary: input.task_goal
      })
    ] : [],
    source_refs: input.materials.map(m => m.content_ref),
  };

  const fullContent = renderFrontmatter(metadata, bodyContent);
  writeTextAtomic(targetPath, fullContent);
  return pathToRepoRef(targetPath, root);
}

/**
 * 追加内容到现有的结构化材料文件
 */
function appendToStructuredMaterial(
  input: MaterialIngestInput,
  _output: MaterialIngestOutput,
  targetPath: string,
  root: string,
  artifactRef: string,
  taskId?: string,
): string {
  // 1. 读取现有文件
  const existingContent = fs.readFileSync(targetPath, 'utf-8');
  const { metadata, body } = parseFrontmatter(existingContent);

  // 2. 更新元数据
  const existingTaskHistory = Array.isArray(metadata.task_history)
    ? metadata.task_history.map(item => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          return item;
        }
      })
    : [];

  const existingSourceRefs = Array.isArray(metadata.source_refs)
    ? metadata.source_refs
    : [];

  const updatedMetadata: Record<string, string | string[] | null> = {
    ...metadata,
    version: incrementPatch(typeof metadata.version === 'string' ? metadata.version : '0.1.0'),
    updated_at: new Date().toISOString(),
    task_history: [
      ...existingTaskHistory.map(item => typeof item === 'string' ? item : JSON.stringify(item)),
      JSON.stringify({
        task_id: taskId || 'unknown',
        updated_at: new Date().toISOString(),
        material_count: input.materials.length,
        summary: input.task_goal
      })
    ],
    source_refs: [
      ...existingSourceRefs,
      ...input.materials.map(m => m.content_ref)
    ],
  };

  // 3. 生成增量章节
  const date = new Date().toISOString().split('T')[0];

  // 3a. 识别清单类材料，追加结构化内容而不仅仅列名称
  const catalogEntries: CatalogEntry[] = [];
  const otherMaterials: MaterialInput[] = [];
  for (const material of input.materials) {
    const content = readMaterialContent(material, root);
    if (isCatalogMaterial(material, content)) {
      catalogEntries.push({
        title: extractCatalogTitle(material.name),
        materialName: material.name,
        lines: renderCatalogMaterialLines(content),
      });
    } else {
      otherMaterials.push(material);
    }
  }

  const incrementalLines: (string | null)[] = [
    `---`,
    ``,
    `## 更新记录 - ${date}`,
    taskId ? `> 任务 ID: ${taskId}` : null,
    ``,
    `### 新增材料`,
    ...input.materials.map((m, i) => `${i + 1}. ${m.name}（${m.source_type || '未分类'}）`),
    ``,
  ];

  // 清单类材料：保留结构追加到"补充材料"下（用四级标题作为条目标题）
  if (catalogEntries.length) {
    incrementalLines.push(`### 补充材料（本次新增）`, ``);
    for (const entry of catalogEntries) {
      incrementalLines.push(`#### ${entry.title}`, ``);
      if (entry.lines.length) {
        // 追加模式下把四级降为五级、列表项保持不变，避免与本节的四级标题冲突
        const dedupedLines = stripLeadingTitleEcho(entry.lines, entry.title);
        for (const line of dedupedLines) {
          if (line.startsWith('#### ')) {
            incrementalLines.push(`##### ${line.slice(5)}`);
          } else {
            incrementalLines.push(line);
          }
        }
      } else {
        incrementalLines.push(`- 未识别到可结构化的条目。`);
      }
      incrementalLines.push('');
    }
  }

  if (otherMaterials.length) {
    incrementalLines.push(
      `### 新增内容摘要`,
      ``,
      `本次补充了 ${otherMaterials.length} 份非清单类材料，主要内容：${input.task_goal}`,
      ``,
    );
  }

  const incrementalSection = incrementalLines
    .filter((line): line is string => line !== null)
    .join('\n');

  // 4. 合并内容
  const updatedBody = `${body.trim()}\n\n${incrementalSection}`;

  // 5. 写回文件
  const updatedContent = renderFrontmatter(updatedMetadata, updatedBody);
  writeTextAtomic(targetPath, updatedContent);

  return pathToRepoRef(targetPath, root);
}

export function renderUserFeedbackLines(input: MaterialIngestInput, root: string): string[] {
  return input.materials.flatMap((material) => {
    if (!isUserFeedbackMaterial(material)) return [];
    return parseUserFeedbackEntries(readMaterialContent(material, root), material.source_owner).map(formatUserFeedback);
  });
}

export function renderSourceMaterialLines(input: MaterialIngestInput, root: string, artifactRef: string): string[] {
  return input.materials.map((material, index) =>
    formatSourceMaterial(material, index, readMaterialContent(material, root), artifactRef)
  );
}

function isUserFeedbackMaterial(material: MaterialInput): boolean {
  return /USER_FEEDBACK|用户反馈|反馈汇总/i.test(`${material.source_type} ${material.name}`);
}

function parseUserFeedbackEntries(content: string, fallbackUserId: string | null): UserFeedbackEntry[] {
  const lines = parseFrontmatter(content).body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s*(?:用户反馈汇总|反馈\s*\d+)/i.test(line) && !/^反馈\s*\d+$/i.test(line));
  const entries: UserFeedbackEntry[] = [];
  let current: UserFeedbackEntry | null = null;

  const flush = () => {
    if (current?.content) entries.push(current);
    current = null;
  };
  for (const line of lines) {
    const userId = line.match(/^[-*]?\s*用户\s*ID\s*[：:]\s*(.+)$/i)?.[1]?.trim();
    if (userId) {
      flush();
      current = { userId, time: null, content: "" };
      continue;
    }
    const time = line.match(/^[-*]?\s*时间\s*[：:]\s*(.+)$/)?.[1]?.trim();
    if (time) {
      current ??= { userId: fallbackUserId, time: null, content: "" };
      current.time = time;
      continue;
    }
    const feedbackContent = line.match(/^[-*]?\s*内容\s*[：:]\s*(.*)$/)?.[1]?.trim();
    if (feedbackContent !== undefined) {
      current ??= { userId: fallbackUserId, time: null, content: "" };
      current.content = feedbackContent;
      continue;
    }
    if (current?.content) current.content = `${current.content} ${line}`;
  }
  flush();

  if (entries.length) return entries;
  const fallbackContent = lines
    .filter((line) => !/^[-*]?\s*(?:用户\s*ID|时间)\s*[：:]/i.test(line))
    .map((line) => line.replace(/^[-*]?\s*内容\s*[：:]\s*/, ""))
    .join(" ")
    .trim();
  return fallbackContent ? [{ userId: fallbackUserId, time: null, content: fallbackContent }] : [];
}

function formatUserFeedback(entry: UserFeedbackEntry): string {
  const content = compactFeedback(entry.content);
  return entry.userId ? `用户 ID：${entry.userId}：${content}` : `用户反馈：${content}`;
}

function formatSourceMaterial(material: MaterialInput, index: number, content: string, artifactRef: string): string {
  const anchor = material.content_ref.endsWith("/materials.md") ? `#material-${index + 1}` : "";
  const feedbackEntries = isUserFeedbackMaterial(material) ? parseUserFeedbackEntries(content, material.source_owner) : [];
  const feedbackUsers = unique(feedbackEntries.flatMap((entry) => entry.userId ? [entry.userId] : []));
  const feedbackTimes = unique(feedbackEntries.flatMap((entry) => entry.time ? [entry.time] : [])).sort();
  const ownerDetail = feedbackUsers.length === 1
    ? `用户 ID：${feedbackUsers[0]}`
    : feedbackUsers.length > 1
      ? `用户：${feedbackUsers.join("、")}`
      : material.source_owner ? `${isUserFeedbackMaterial(material) ? "用户 ID" : "提供方"}：${material.source_owner}` : null;
  const timeDetail = feedbackTimes.length === 1
    ? `日期：${feedbackTimes[0]}`
    : feedbackTimes.length > 1
      ? `日期：${feedbackTimes[0]} 至 ${feedbackTimes[feedbackTimes.length - 1]}`
      : material.source_time ? `日期：${material.source_time}` : null;
  const details = [
    ownerDetail,
    timeDetail,
    `类型：${sourceTypeLabel(material.source_type)}`,
  ].filter((item): item is string => item !== null);
  const displayName = sourceDisplayName(material, index, feedbackEntries);
  const href = markdownSourceHref(material.content_ref, artifactRef, anchor);
  return `[${escapeMarkdownLabel(displayName)}](${href})（${details.join("；")}）`;
}

function sourceDisplayName(material: MaterialInput, index: number, feedbackEntries: UserFeedbackEntry[]): string {
  const name = material.name.trim();
  const genericFeedbackName = name.match(/^(?:用户)?反馈\s*(\d+)(?=$|[_.：:\-\s])/i);
  if (!isUserFeedbackMaterial(material) || !genericFeedbackName) return name;
  const sequence = genericFeedbackName[1] ?? String(index + 1);
  const summary = feedbackSummary(feedbackEntries[0]?.content ?? "");
  return summary ? `反馈${sequence}：${summary}` : `反馈${sequence}`;
}

function feedbackSummary(content: string): string {
  const normalized = compactFeedback(content);
  const quoted = normalized.match(/["“]([^"”]{1,30})["”]/u)?.[1]?.trim();
  if (quoted) return /拼音/.test(normalized) ? `拼音 ${quoted}` : quoted;
  const firstClause = normalized
    .split(/[，。！？；,.!?;]/u)[0]
    .replace(/^(?:用户反馈|内容)\s*[：:]\s*/u, "")
    .trim();
  return firstClause.length > 24 ? `${firstClause.slice(0, 24)}...` : firstClause;
}

function markdownSourceHref(sourceRef: string, artifactRef: string, anchor: string): string {
  if (!sourceRef.startsWith("repo://") || !artifactRef.startsWith("repo://")) return `${sourceRef}${anchor}`;
  const sourcePath = sourceRef.slice("repo://".length);
  const artifactPath = artifactRef.slice("repo://".length);
  const relative = path.posix.relative(path.posix.dirname(artifactPath), sourcePath);
  return `${relative || path.posix.basename(sourcePath)}${anchor}`;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function sourceTypeLabel(sourceType: string): string {
  const labels: Record<string, string> = {
    USER_FEEDBACK: "用户反馈",
    MEETING_NOTE: "会议记录",
    PRODUCT_DOC: "产品文档",
    BUSINESS_RULE: "业务规则",
    DECISION: "决策记录",
  };
  return labels[sourceType.toUpperCase()] ?? sourceType;
}

/**
 * 检测一行文本是否为标题
 * 支持四种格式：
 * 1. Markdown 标题：## 标题
 * 2. 数字编号标题：1 做什么、1. 做什么、1） 做什么
 * 3. 中文编号标题：一、做什么
 * 4. 纯文本标题：产品边界（需匹配关键词）
 */
function detectHeading(line: string): HeadingInfo {
  const trimmed = line.trim();
  if (!trimmed) return { isHeading: false, level: 0, text: '' };

  // 1. Markdown 标题：## 标题
  const markdownMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (markdownMatch) {
    return {
      isHeading: true,
      level: markdownMatch[1].length,
      text: markdownMatch[2].trim(),
    };
  }

  // 2. 数字编号标题：1 做什么、1. 做什么、1） 做什么、1) 做什么
  const numberMatch = trimmed.match(/^(\d+)[.)、）\s]\s*(.+)$/);
  if (numberMatch) {
    const text = numberMatch[2].trim();
    // 条件：后续文本 ≤ 20 字，不含句中标点
    if (text.length <= 20 && !/[，。；,;]/.test(text)) {
      return {
        isHeading: true,
        level: 2,
        text: `${numberMatch[1]} ${text}`,
      };
    }
  }

  // 3. 中文编号标题：一、做什么
  const chineseNumberMatch = trimmed.match(/^([一二三四五六七八九十百千万]+)[、\s]\s*(.+)$/);
  if (chineseNumberMatch) {
    const text = chineseNumberMatch[2].trim();
    // 条件：后续文本 ≤ 20 字，不含句中标点
    if (text.length <= 20 && !/[，。；,;]/.test(text)) {
      return {
        isHeading: true,
        level: 2,
        text: `${chineseNumberMatch[1]}、${text}`,
      };
    }
  }

  // 4. 纯文本标题：产品边界（需匹配关键词）
  // 条件：长度 ≤ 15 字，不含句中标点，匹配关键词
  if (trimmed.length <= 15 && !/[，。；,;]/.test(trimmed)) {
    const headingKeywords = /背景|边界|目标|范围|定位|说明|概述|介绍|总结|结论|问题|方案|计划|流程|架构|设计|实现|测试|部署|上线|发布|迭代|版本|功能|需求|用户|产品|技术|业务|数据|接口|系统|模块|组件|服务|平台|工具|规则|策略|原则|标准|规范|约定|注意|风险|依赖|限制|假设|前提/;
    if (headingKeywords.test(trimmed)) {
      return {
        isHeading: true,
        level: 1,
        text: trimmed,
      };
    }
  }

  return { isHeading: false, level: 0, text: '' };
}

function parseMaterialSegments(content: string, isMeeting: boolean): MaterialSegment[] {
  const cleanLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || /source_id:|^---$/.test(line)) return false;
      // 移除过于激进的 Markdown 标题过滤，让标题进入处理流程
      return true;
    });
  if (!cleanLines.length) return [];

  const blocks: MaterialSegment[] = [];
  for (const line of cleanLines) {
    // 检测标题
    const headingInfo = detectHeading(line);
    if (headingInfo.isHeading) {
      // 标题保持完整，不进行句子分割
      blocks.push({ speaker: null, content: line });
      continue;
    }

    // 原有逻辑处理非标题行
    const speakerMatch = isMeeting ? line.match(/^([^：:]{1,20})[：:]\s*(.*)$/u) : null;
    const speaker = speakerMatch && looksLikeSpeakerLine(line) ? speakerMatch[1].trim() : null;
    const contentPart = speakerMatch && speaker ? speakerMatch[2].trim() : line;
    for (const item of splitNumberedItems(contentPart)) {
      blocks.push(...splitIntoSegments(item, speaker));
    }
  }
  return blocks.length ? blocks : splitIntoSegments(cleanLines.join(" "), null);
}

function looksLikeSpeakerLine(line: string): boolean {
  const match = line.match(/^(.{1,20}?)[：:]\s*(.+)/);
  if (!match) return false;
  const prefix = match[1].trim();
  return prefix.length <= 12 && !/[，。！？；,.!?;]/.test(prefix);
}

function splitIntoSegments(content: string, speaker: string | null): MaterialSegment[] {
  return content
    .split(/(?<=[。！？；!?;])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ speaker, content: part }));
}

function splitNumberedItems(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const matches = [...normalized.matchAll(/(?:^|\s)(\d+)[.)、]\s*/gu)];
  if (!matches.length) return [normalized];

  const items: string[] = [];
  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    const item = normalized.slice(start, end).trim();
    if (item) items.push(item);
  }
  return items;
}

function classifySegment(segment: MaterialSegment): string {
  const { content } = segment;
  const text = content;

  // 1. 明确决策
  if (/那[咱我]们?第一期先|那这次先定|先不做|不做完整|先解决|目标是|决定了|第一期只做|先定/.test(text) &&
      !/先看|是不是|如果要做/.test(text)) {
    return "已确认决策";
  }

  // 2. 风险与待确认
  if (/风险|注意|脱敏|敏感|确认一下|待确认|需要和.*确认|要跟.*确认|需.*确认/.test(text) &&
      !/方案|建议|可以做|能做/.test(text)) {
    return "风险与待确认";
  }

  // 3. 行动项与分工
  if (/周[一二三四五六日天].*给|下班前|下周[一二三].*给|负责|我来写|我来整理|我来出|PRD.*初稿|给出|交付|截止|DDL|deadline/i.test(text)) {
    return "行动项与分工";
  }

  // 4. 用户反馈 / 数据
  if (/用户|客服|咨询|搜不到|没搜到|搜索|反馈|希望|经常搜|统计|大概.*%|占比|数据|Top\s*\d+/i.test(text) &&
      !/方案|建议|先做|可以做|第一期|优化/.test(text)) {
    return "用户反馈";
  }

  // 5. 观点与方案
  if (/可以|建议|方案|短期|第一期|要做|做两件|维护一批|常见问题|维护规则|先维护|先做|能做|自动理解|向量|召回|排序|配置|打通|格式|比如|例如/.test(text)) {
    return "观点与方案";
  }

  // 6. 行动项兜底
  if (/给 |给出|评估|出 |整理|拿到|负责|我来/.test(text)) {
    return "行动项与分工";
  }

  // 7. 确认兜底
  if (/好[。，]|行[。，]|可以[。，]|没问题|就这么|同意|OK/i.test(text)) {
    return "已确认决策";
  }

  return "背景与事实";
}

function summarizeSegment(segment: MaterialSegment, category: string): string {
  const source = compact(segment.content);
  const speaker = segment.speaker ? `${segment.speaker}：` : "";
  if (category === "用户反馈") return `用户/客服反馈：${source}`;
  if (category === "观点与方案") return `方案建议：${source}`;
  if (category === "已确认决策") return `会议决定：${source}`;
  if (category === "行动项与分工") return `${speaker}${source}`;
  if (category === "风险与待确认") return `风险/待确认：${source}`;
  return `${speaker}${source}`;
}

function compact(value: string): string {
  // 检测是否为标题
  const headingInfo = detectHeading(value);
  if (headingInfo.isHeading) {
    // 标题原样返回，不做截断和清理
    return value;
  }

  // 非标题才执行清理逻辑
  return value
    .replace(/^[-*]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[。！？；!?;]+$/u, "")
    .slice(0, 220);
}

function compactFeedback(value: string): string {
  return value
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[。！？；!?;]+$/u, "")
    .trim();
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}

/**
 * 渲染"## 补充材料"二级容器，每份清单类材料落在一个 "### 标题" 三级 section 下，
 * 原文层级由 renderCatalogMaterialLines 保留。无清单类材料则不输出该 section。
 */
function renderCatalogSection(entries: CatalogEntry[]): string[] {
  if (!entries.length) return [];
  const out: string[] = ["## 补充材料", ""];
  for (const entry of entries) {
    out.push(`### ${entry.title}`, "");
    const dedupedLines = stripLeadingTitleEcho(entry.lines, entry.title);
    if (dedupedLines.length) {
      out.push(...dedupedLines);
    } else {
      out.push("- 未识别到可结构化的条目。");
    }
    out.push("");
  }
  return out;
}

/**
 * 去掉材料首行与 section 标题重复的"回响"。
 *   例：section 是 "### 产品边界"，材料首行也叫 "产品边界"
 *       → 会被渲染成 "- 产品边界"，与标题重复；此处剥掉。
 * 只处理开头几行（含可能存在的前置空行），避免误删正文里同名的普通条目。
 */
function stripLeadingTitleEcho(lines: string[], title: string): string[] {
  const echo = `- ${title}`;
  const result = [...lines];
  while (result.length && (result[0] === "" || result[0] === echo)) {
    const wasEcho = result[0] === echo;
    result.shift();
    if (wasEcho) {
      // 顺带吃掉紧跟其后的空行，避免"### 产品边界"下出现连续空行
      if (result.length && result[0] === "") result.shift();
      break;
    }
  }
  return result;
}

/**
 * 渲染"## 来源材料" section。抽出来单独处理是为了保证它固定排在最后。
 */
function renderSourceMaterialSection(lines: string[]): string[] {
  const out = ["## 来源材料", ""];
  if (!lines.length) {
    out.push("- 未从原文识别到明确内容，需人工补充。", "");
    return out;
  }
  for (const line of unique(lines)) {
    out.push(`- ${line}`);
  }
  out.push("");
  return out;
}

/**
 * 判断材料是否为"结构化清单类"（指标清单、边界说明、规则列表等）。
 * 命中后走透传渲染，避免被六大分类硬拆。
 *
 * 触发条件（需同时满足）：
 *   1. 不是会议记录、也不是用户反馈类（这两类走既有专用路径）
 *   2. source_type / name 命中清单关键词，或内容整体呈"多短行、少句号"的清单形态
 */
function isCatalogMaterial(material: MaterialInput, content: string): boolean {
  if (isUserFeedbackMaterial(material)) return false;
  const label = `${material.source_type} ${material.name}`;
  if (/MEETING|会议|纪要|记录/i.test(label)) return false;

  const explicit =
    CATALOG_SOURCE_TYPE_KEYWORDS.test(material.source_type || "") ||
    CATALOG_NAME_KEYWORDS.test(material.name || "");

  if (explicit) return true;

  // 内容形态兜底判断：≥3 行、平均行长 ≤ 40、句末标点占比低
  const body = parseFrontmatter(content).body;
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;

  const avgLength = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
  const sentenceLike = lines.filter((line) => /[。！？]/.test(line)).length;
  return avgLength <= 40 && sentenceLike / lines.length < 0.3;
}

/**
 * 从材料 name 提取三级标题。
 *   例：'PRD评审智能体核心指标' → '核心指标'
 *   例：'XX产品边界'             → '产品边界'
 * 找不到匹配的关键词后缀则使用整个 name。
 */
function extractCatalogTitle(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "补充材料";
  for (const suffix of CATALOG_TITLE_SUFFIXES) {
    if (trimmed.endsWith(suffix)) return suffix;
  }
  return trimmed;
}

/**
 * 把清单类材料原文渲染为结构化 markdown 行：
 *   - "xxx：" / "xxx:" 结尾的短行 → "#### xxx"（四级子标题）
 *   - 数字或中文编号的短行         → "#### <text>"
 *   - Markdown 标题行 (# ~ ###)   → "#### <text>"（统一降到四级）
 *   - 其他行                       → "- <text>" 列表项
 * 目的：保留原始层级，同时避免出现悬空的一级/二级标题干扰整体大纲。
 */
function renderCatalogMaterialLines(content: string): string[] {
  const body = parseFrontmatter(content).body;
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const output: string[] = [];
  let lastWasHeading = false;

  for (const raw of lines) {
    // 1. 已有 markdown 标题 → 统一降到四级
    const mdHeading = raw.match(/^#{1,6}\s+(.+)$/);
    if (mdHeading) {
      if (!lastWasHeading && output.length) output.push("");
      output.push(`#### ${mdHeading[1].trim()}`, "");
      lastWasHeading = true;
      continue;
    }

    // 2. "xxx：" / "xxx:" 结尾的短标签行 → 四级子标题
    const labelMatch = raw.match(/^(.{1,20}?)[：:]\s*$/u);
    if (labelMatch) {
      if (!lastWasHeading && output.length) output.push("");
      output.push(`#### ${labelMatch[1].trim()}`, "");
      lastWasHeading = true;
      continue;
    }

    // 3. 数字/中文编号 + 短文本 → 四级子标题（如 "1 做什么"、"一、做什么"）
    const numberedShort = raw.match(/^(\d+)[.)、）\s]\s*(.+)$/) || raw.match(/^([一二三四五六七八九十]+)[、\s]\s*(.+)$/);
    if (numberedShort) {
      const [, marker, text] = numberedShort;
      const clean = text.trim();
      if (clean.length <= 20 && !/[，。；,;]/.test(clean)) {
        if (!lastWasHeading && output.length) output.push("");
        output.push(`#### ${marker} ${clean}`, "");
        lastWasHeading = true;
        continue;
      }
    }

    // 4. 其他行 → 列表项，剥掉现有的列表前缀
    const cleaned = raw.replace(/^[-*]\s*/, "").replace(/^\d+[.)、]\s*/, "").trim();
    if (cleaned) {
      output.push(`- ${cleaned}`);
      lastWasHeading = false;
    }
  }

  return output;
}
