import * as fs from "node:fs";
import type { MaterialInput } from "./context-types.js";
import type { IngestionMaterialRecord } from "./material-manifest.js";
import { parseFrontmatter, renderFrontmatter, repoRefToPath, writeTextAtomic } from "./repository.js";

export const MATERIAL_BUNDLE_FILE = "materials.md";

export interface MaterialBundleEntry extends IngestionMaterialRecord {
  content: string;
}

export interface MaterialBundleHeader {
  task_id: string;
  task_goal: string;
  registered_at: string;
  updated_at: string;
  project_id?: string;
  structured_material_ref?: string | null;
}

/**
 * 写入材料 bundle：
 * - 顶部 YAML frontmatter 保存任务级元信息（task_id / task_goal / 时间 / 整理稿指针）
 * - 每条材料由 `<!-- context-material: <fields> -->` 头包裹，字段用 key=value 编码，
 *   便于产品经理人读、Runtime 冷启动重建 manifest。
 */
export function writeMaterialBundle(
  filePath: string,
  entries: MaterialBundleEntry[],
  header: MaterialBundleHeader,
): void {
  const metadata: Record<string, string | string[] | null> = {
    task_id: header.task_id,
    task_goal: header.task_goal || "",
    registered_at: header.registered_at,
    updated_at: header.updated_at,
  };
  if (header.project_id) metadata.project_id = header.project_id;
  if (header.structured_material_ref) metadata.structured_material_ref = header.structured_material_ref;

  const body = entries.map((entry, index) => [
    `<a id="material-${index + 1}"></a>`,
    renderMaterialHeaderComment(entry),
    entry.content,
    "<!-- context-material-end -->",
    "",
  ].join("\n")).join("\n");

  writeTextAtomic(filePath, renderFrontmatter(metadata, body));
}

function renderMaterialHeaderComment(entry: MaterialBundleEntry): string {
  const attrs: string[] = [`source_id=${entry.source_id ?? "unknown"}`];
  if (entry.original_name) attrs.push(`original_name=${escapeAttr(entry.original_name)}`);
  if (entry.source_type) attrs.push(`source_type=${escapeAttr(entry.source_type)}`);
  if (entry.source_owner) attrs.push(`source_owner=${escapeAttr(entry.source_owner)}`);
  if (entry.source_time) attrs.push(`source_time=${escapeAttr(entry.source_time)}`);
  attrs.push(`is_complete=${entry.is_complete ? "true" : "false"}`);
  return `<!-- context-material: ${attrs.join(" | ")} -->`;
}

function escapeAttr(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/-->/g, "--&gt;");
}

function unescapeAttr(value: string): string {
  return value.replace(/&#124;/g, "|").replace(/--&gt;/g, "-->");
}

function parseMaterialHeaderComment(headerLine: string): Record<string, string> {
  const inner = headerLine.replace(/^<!--\s*context-material:\s*/, "").replace(/\s*-->$/, "");
  const attrs: Record<string, string> = {};
  for (const part of inner.split("|")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      if (trimmed && !attrs.source_id) attrs.source_id = trimmed;
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    attrs[key] = unescapeAttr(val);
  }
  return attrs;
}

export function readMaterialBundle(filePath: string, sourceId?: string): string {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { body } = parseFrontmatter(raw);
  const content = body || raw;
  if (!sourceId || !content.includes("<!-- context-material:")) return content;
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 兼容 legacy 只带 source_id 的注释，也兼容新格式 "source_id=xxx | ..."。
  const match = content.match(
    new RegExp(`<!-- context-material:[^\\n]*?${escaped}[^\\n]*?-->\\n([\\s\\S]*?)\\n<!-- context-material-end -->`),
  );
  if (!match) throw new Error(`汇总材料中不存在来源: ${sourceId}`);
  return match[1];
}

export interface ParsedMaterialBundle {
  header: MaterialBundleHeader | null;
  materials: Array<{ attrs: Record<string, string>; content: string }>;
}

/** 解析一整份 bundle 文件，返回 header 与每条材料的属性与正文。 */
export function parseMaterialBundle(filePath: string): ParsedMaterialBundle {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { metadata, body } = parseFrontmatter(raw);
  const header: MaterialBundleHeader | null = typeof metadata.task_id === "string" ? {
    task_id: metadata.task_id,
    task_goal: typeof metadata.task_goal === "string" ? metadata.task_goal : "",
    registered_at: typeof metadata.registered_at === "string" ? metadata.registered_at : "",
    updated_at: typeof metadata.updated_at === "string" ? metadata.updated_at : "",
    project_id: typeof metadata.project_id === "string" ? metadata.project_id : undefined,
    structured_material_ref: typeof metadata.structured_material_ref === "string" ? metadata.structured_material_ref : null,
  } : null;

  const materials: Array<{ attrs: Record<string, string>; content: string }> = [];
  const regex = /<!-- context-material:([^\n]*?)-->\n([\s\S]*?)\n<!-- context-material-end -->/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const attrs = parseMaterialHeaderComment(`<!-- context-material:${match[1]}-->`);
    materials.push({ attrs, content: match[2] });
  }
  return { header, materials };
}

export function readMaterialContent(material: Pick<MaterialInput, "source_id" | "content_ref">, root: string): string {
  return readMaterialBundle(repoRefToPath(material.content_ref, root), material.source_id);
}
