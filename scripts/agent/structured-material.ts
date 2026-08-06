import * as fs from "node:fs";
import type { MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import { pathToRepoRef, repoRefToPath, writeTextAtomic } from "../lib/repository.js";

interface MaterialSegment {
  speaker: string | null;
  content: string;
}

export function writeStructuredMaterial(
  input: MaterialIngestInput,
  _output: MaterialIngestOutput,
  targetPath: string,
  root: string,
  artifactRef = pathToRepoRef(targetPath, root),
): string {
  const isMeeting = input.materials.some((material) =>
    /MEETING|会议|纪要|记录/i.test(`${material.source_type} ${material.name}`)
  );
  const title = isMeeting ? "会议记录整理稿" : "结构化材料整理稿";

  const sections = new Map<string, string[]>();
  for (const key of ["背景与事实", "用户反馈", "观点与方案", "已确认决策", "行动项与分工", "风险与待确认", "来源材料"]) {
    sections.set(key, []);
  }

  for (const material of input.materials) {
    const materialPath = repoRefToPath(material.content_ref, root);
    const content = fs.readFileSync(materialPath, "utf-8");
    const segments = parseMaterialSegments(content, isMeeting);

    for (const segment of segments) {
      const category = classifySegment(segment);
      const entry = summarizeSegment(segment, category);
      sections.get(category)?.push(entry);
    }

    sections.get("来源材料")?.push(`${material.name}（${material.source_id}，${material.source_type}）`);
  }

  const body = [
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
    ...[...sections.entries()].flatMap(([heading, lines]) => [
      `## ${heading}`,
      "",
      ...(lines.length ? unique(lines).map((line) => `- ${line}`) : ["- 未从原文识别到明确内容，需人工补充。"]),
      "",
    ]),
    "## 原文保留说明",
    "",
    "原始材料已由 Runtime 登记到 `context-workspace/drafts/`，本整理稿不替换原文。",
    "",
  ].join("\n");
  writeTextAtomic(targetPath, body);
  return pathToRepoRef(targetPath, root);
}

function parseMaterialSegments(content: string, isMeeting: boolean): MaterialSegment[] {
  const cleanLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/source_id:|^---$/.test(line));
  if (!cleanLines.length) return [];

  const hasSpeakerMarkers = isMeeting && cleanLines.some((line) => looksLikeSpeakerLine(line));
  if (!hasSpeakerMarkers) {
    return splitIntoSegments(cleanLines.join(" "), null);
  }

  const blocks: MaterialSegment[] = [];
  const normalized = cleanLines.join(" ");
  const marker = /([^：:，。！？；\s]{1,12})[：:]\s*/gu;
  const matches = [...normalized.matchAll(marker)];
  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    const contentPart = normalized.slice(start, end).trim();
    if (contentPart) blocks.push(...splitIntoSegments(contentPart, match[1]));
  }
  return blocks.length ? blocks : splitIntoSegments(normalized, null);
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
  return value
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[。！？；!?;]+$/u, "")
    .slice(0, 220);
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}
