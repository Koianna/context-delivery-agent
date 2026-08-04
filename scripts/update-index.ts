#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import { incrementPatch, parseFrontmatter, renderFrontmatter, writeTextAtomic } from "./lib/repository.js";

interface IndexEntry {
  relativePath: string;
  title: string;
  status: string;
  version: string;
}

export function updateIndex(root = PROJECT_ROOT, updated = new Date().toISOString().slice(0, 10)) {
  const contextDir = path.join(root, "context-workspace/context");
  const indexPath = path.join(contextDir, "INDEX.md");
  const current = parseFrontmatter(fs.readFileSync(indexPath, "utf-8"));
  const currentVersion = typeof current.metadata.version === "string" ? current.metadata.version : "0.0.0";
  const groups: Record<string, IndexEntry[]> = {
    product: [], users: [], "business-rules": [], glossary: []
  };

  for (const group of Object.keys(groups)) {
    const directory = path.join(contextDir, group);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".md")).sort()) {
      const filePath = path.join(directory, name);
      const document = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
      const title = document.body.match(/^#\s+(.+)$/m)?.[1] ?? name;
      groups[group].push({
        relativePath: `${group}/${name}`,
        title,
        status: String(document.metadata.status ?? "unknown"),
        version: String(document.metadata.version ?? "unknown")
      });
    }
  }

  const body = [
    "# Context 索引",
    "",
    renderSection("产品", groups.product),
    renderSection("用户", groups.users),
    renderSection("业务规则", groups["business-rules"]),
    renderSection("术语表", groups.glossary),
    "> 此索引由 `scripts/update-index.ts` 根据稳定 Context 文件生成。"
  ].join("\n");
  if (current.body.trim() === body.trim()) {
    return { status: "UNCHANGED", version: currentVersion, entry_count: Object.values(groups).flat().length };
  }
  const nextVersion = incrementPatch(currentVersion);
  writeTextAtomic(indexPath, renderFrontmatter({ version: nextVersion, updated, project: "help-center-search" }, body));
  return { status: "UPDATED", version: nextVersion, entry_count: Object.values(groups).flat().length };
}

function renderSection(label: string, entries: IndexEntry[]): string {
  const lines = [`## ${label}`, "", "| 文件 | 主题 | 状态 | 版本 |", "|---|---|---|---|"];
  for (const entry of entries) {
    lines.push(`| [${entry.relativePath}](${entry.relativePath}) | ${entry.title} | ${entry.status} | ${entry.version} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const updated = argVal(args, "--updated");
  console.log(JSON.stringify(updateIndex(PROJECT_ROOT, updated), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
