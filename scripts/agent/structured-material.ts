import * as fs from "node:fs";
import * as path from "node:path";
import type { MaterialIngestInput, MaterialIngestOutput } from "../lib/context-types.js";
import { pathToRepoRef, repoRefToPath, writeTextAtomic } from "../lib/repository.js";

export function writeStructuredMaterial(
  input: MaterialIngestInput,
  output: MaterialIngestOutput,
  targetPath: string,
  root: string
): string {
  const isMeeting = input.materials.some((material) =>
    /MEETING|会议|纪要|记录/i.test(`${material.source_type} ${material.name}`)
  );
  const title = isMeeting ? "会议记录整理稿" : "结构化材料整理稿";
  const sections = new Map<string, string[]>();
  for (const key of ["背景与事实", "用户反馈", "观点与方案", "已确认决策", "行动项", "风险与待确认", "来源材料"]) {
    sections.set(key, []);
  }

  for (const material of input.materials) {
    const materialPath = repoRefToPath(material.content_ref, root);
    const content = fs.readFileSync(materialPath, "utf-8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/source_id:|^---$|^[#*-]+\s*$/.test(line)) continue;
      const target = classifyLine(line, isMeeting);
      sections.get(target)?.push(line);
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
    `- 产物引用：${pathToRepoRef(targetPath, root)}`,
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

function classifyLine(line: string, isMeeting: boolean): string {
  if (/风险|注意|脱敏|敏感|确认一下|待确认|依赖|不能|来不及|需要和/.test(line)) return "风险与待确认";
  if (/周[一二三四五六日天]|下周|本周|截止|负责|给 |给出|整理|评估|出 PRD|交付|拿到词/.test(line)) return "行动项";
  if (/第一期先|这次先定|好。|确定|决定|目标是|先不做|不做完整|先解决/.test(line)) return "已确认决策";
  if (/可以|建议|方案|短期|第一期|要做|做两件|维护一批|推荐热门|关键词别名/.test(line)) return "观点与方案";
  if (/用户|客服|咨询|搜不到|没搜到|搜索|反馈|希望|经常搜|问题变多/.test(line)) return "用户反馈";
  return isMeeting ? "背景与事实" : "背景与事实";
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}
