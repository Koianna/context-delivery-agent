import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT, AGENT_RUNS_DIR } from "./config.js";

export interface FrontmatterDocument {
  metadata: Record<string, string | string[] | null>;
  body: string;
}

export function repoRefToPath(ref: string, root = PROJECT_ROOT): string {
  if (ref.startsWith("runs://")) {
    return runsRefToPath(ref, root);
  }
  if (!ref.startsWith("repo://")) {
    throw new Error(`只支持 repo:// 或 runs:// 引用: ${ref}`);
  }
  const relative = ref.slice("repo://".length);
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`非法仓库引用: ${ref}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`仓库引用越界: ${ref}`);
  }
  return resolved;
}

function runsRefToPath(ref: string, root: string): string {
  const relative = ref.slice("runs://".length);
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`非法运行引用: ${ref}`);
  }
  const resolvedRoot = path.resolve(root);
  const runsBase = path.resolve(resolvedRoot, AGENT_RUNS_DIR);
  const resolved = path.resolve(runsBase, relative);
  if (resolved !== runsBase && !resolved.startsWith(runsBase + path.sep)) {
    throw new Error(`运行引用越界: ${ref}`);
  }
  return resolved;
}

export function pathToRepoRef(filePath: string, root = PROJECT_ROOT): string {
  const resolvedRoot = path.resolve(root);
  const runsBase = path.resolve(resolvedRoot, AGENT_RUNS_DIR);
  const absPath = path.resolve(filePath);
  if (absPath === runsBase || absPath.startsWith(runsBase + path.sep)) {
    const runsRel = path.relative(runsBase, absPath);
    return `runs://${runsRel.split(path.sep).join("/")}`;
  }
  const relative = path.relative(resolvedRoot, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径不在仓库内: ${filePath}`);
  }
  return `repo://${relative.split(path.sep).join("/")}`;
}

/** 生成 runs:// ref 的辅助函数，供 Runtime 内部使用。 */
export function runsRef(...segments: string[]): string {
  const joined = segments.join("/").replace(/^\/+/, "");
  return `runs://${joined}`;
}

/** 返回 <PROJECT_ROOT>/.cache/agent-runs/<...segments> 的绝对路径。 */
export function agentRunsPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, AGENT_RUNS_DIR, ...segments);
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, filePath);
}

export function writeTextAtomic(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, value, "utf-8");
  fs.renameSync(tempPath, filePath);
}

export function parseFrontmatter(markdown: string): FrontmatterDocument {
  if (!markdown.startsWith("---\n")) {
    return { metadata: {}, body: markdown.trim() + "\n" };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("Markdown frontmatter 未闭合");

  const lines = markdown.slice(4, end).split("\n");
  const metadata: Record<string, string | string[] | null> = {};
  let listKey: string | null = null;
  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && listKey) {
      const list = metadata[listKey];
      if (Array.isArray(list)) list.push(unquote(listMatch[1]));
      continue;
    }
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const [, key, rawValue] = fieldMatch;
    if (rawValue === "") {
      metadata[key] = [];
      listKey = key;
    } else {
      metadata[key] = rawValue === "null" ? null : unquote(rawValue);
      listKey = null;
    }
  }
  return { metadata, body: markdown.slice(end + 5).trim() + "\n" };
}

export function renderFrontmatter(
  metadata: Record<string, string | string[] | null>,
  body: string
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value ?? "null"}`);
    }
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

export function incrementPatch(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`版本不是语义版本: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}
