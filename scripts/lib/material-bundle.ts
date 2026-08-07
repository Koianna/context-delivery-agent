import * as fs from "node:fs";
import type { MaterialInput } from "./context-types.js";
import type { IngestionMaterialRecord } from "./material-manifest.js";
import { repoRefToPath, writeTextAtomic } from "./repository.js";

export const MATERIAL_BUNDLE_FILE = "materials.md";

export interface MaterialBundleEntry extends IngestionMaterialRecord {
  content: string;
}

export function writeMaterialBundle(filePath: string, entries: MaterialBundleEntry[]): void {
  const content = entries.map((entry, index) => [
    `<a id="material-${index + 1}"></a>`,
    `<!-- context-material: ${entry.source_id ?? "unknown"} -->`,
    entry.content,
    "<!-- context-material-end -->",
    "",
  ].join("\n")).join("\n");
  writeTextAtomic(filePath, content);
}

export function readMaterialBundle(filePath: string, sourceId?: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  if (!sourceId || !content.includes("<!-- context-material:")) return content;
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`<!-- context-material: ${escaped} -->\\n([\\s\\S]*?)\\n<!-- context-material-end -->`));
  if (!match) throw new Error(`汇总材料中不存在来源: ${sourceId}`);
  return match[1];
}

export function readMaterialContent(material: Pick<MaterialInput, "source_id" | "content_ref">, root: string): string {
  return readMaterialBundle(repoRefToPath(material.content_ref, root), material.source_id);
}
