import * as path from "node:path";
import { sha256Buffer } from "../lib/change-snapshot.js";
import { PROJECT_ROOT } from "../lib/config.js";
import { safeProjectSlug } from "../lib/project-paths.js";
import { writeJsonAtomic, writeTextAtomic } from "../lib/repository.js";
import type { ExternalAgentMaterial } from "./types.js";

export const INLINE_MATERIAL_MAX_BYTES = 200_000;
export const INLINE_MATERIAL_TOTAL_MAX_BYTES = 1_000_000;

export class InlineMaterialError extends Error {
  constructor(public readonly code: "INVALID_TOOL_INPUT" | "MATERIAL_TOO_LARGE", message: string) {
    super(message);
    this.name = "InlineMaterialError";
  }
}

export function writeInlineMaterials(
  materials: ExternalAgentMaterial[],
  projectId: string,
  taskId: string,
  root = PROJECT_ROOT,
): string {
  if (!materials.length) throw new InlineMaterialError("INVALID_TOOL_INPUT", "materials 不能为空");
  let totalBytes = 0;
  const project = safeProjectSlug(projectId);
  const task = safeSlug(taskId);
  const targetDir = path.join(
    root,
    "context-workspace/drafts",
    project,
    "source-materials",
    task,
  );
  const manifest = materials.map((material, index) => {
    if (!material.name.trim()) throw new InlineMaterialError("INVALID_TOOL_INPUT", `第 ${index + 1} 份材料缺少 name`);
    if (!material.content.trim()) throw new InlineMaterialError("INVALID_TOOL_INPUT", `材料 ${material.name} 的 content 不能为空`);
    const bytes = Buffer.byteLength(material.content, "utf8");
    if (bytes > INLINE_MATERIAL_MAX_BYTES) {
      throw new InlineMaterialError("MATERIAL_TOO_LARGE", `材料 ${material.name} 超过 ${INLINE_MATERIAL_MAX_BYTES} 字节限制`);
    }
    totalBytes += bytes;
    if (totalBytes > INLINE_MATERIAL_TOTAL_MAX_BYTES) {
      throw new InlineMaterialError("MATERIAL_TOO_LARGE", `本次内联材料总量超过 ${INLINE_MATERIAL_TOTAL_MAX_BYTES} 字节限制`);
    }
    const storedName = `${String(index + 1).padStart(3, "0")}-${safeFileName(material.name)}`;
    const filePath = path.join(targetDir, storedName);
    writeTextAtomic(filePath, material.content);
    return {
      source_id: `src-${sha256Buffer(Buffer.from(material.content, "utf8")).slice(0, 10)}`,
      original_name: material.name,
      stored_name: storedName,
      source_type: material.source_type ?? null,
      source_owner: material.source_owner ?? null,
      source_time: material.source_time ?? null,
      is_complete: material.is_complete ?? true,
      content_bytes: bytes,
    };
  });
  writeJsonAtomic(path.join(targetDir, "ingest-manifest.json"), {
    project_id: project,
    task_id: taskId,
    materials: manifest,
  });
  return targetDir;
}

function safeFileName(value: string): string {
  const base = path.basename(value.trim()).replace(/[\\/]/g, "-");
  const normalized = base.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") return "material.md";
  return /\.(md|markdown|txt|json)$/i.test(normalized) ? normalized : `${normalized}.md`;
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `task-${Date.now()}`;
}
