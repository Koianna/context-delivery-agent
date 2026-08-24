import * as path from "node:path";
import { materialBodySha256 } from "../lib/change-snapshot.js";
import { PROJECT_ROOT } from "../lib/config.js";
import { MATERIAL_BUNDLE_FILE, writeMaterialBundle, type MaterialBundleEntry } from "../lib/material-bundle.js";
import { upsertMaterialIngestion, type IngestionMaterialRecord } from "../lib/material-manifest.js";
import { safeProjectSlug } from "../lib/project-paths.js";
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
  taskGoal = "",
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
  const entries: MaterialBundleEntry[] = materials.map((material, index) => {
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
    return {
      source_id: `src-${materialBodySha256(Buffer.from(material.content, "utf8")).slice(0, 10)}`,
      original_name: material.name,
      stored_name: MATERIAL_BUNDLE_FILE,
      source_type: material.source_type ?? null,
      source_owner: material.source_owner ?? null,
      source_time: material.source_time ?? null,
      is_complete: material.is_complete ?? true,
      content_bytes: bytes,
      content: material.content,
    };
  });
  const nowIso = new Date().toISOString();
  writeMaterialBundle(path.join(targetDir, MATERIAL_BUNDLE_FILE), entries, {
    task_id: taskId,
    task_goal: taskGoal,
    registered_at: nowIso,
    updated_at: nowIso,
    project_id: project,
  });
  upsertMaterialIngestion(project, {
    task_id: taskId,
    task_goal: taskGoal,
    updated_at: nowIso,
    materials: entries.map(({ content: _content, ...manifest }) => ({
      ...manifest,
      stored_name: MATERIAL_BUNDLE_FILE,
    })) as IngestionMaterialRecord[],
  });
  return targetDir;
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `task-${Date.now()}`;
}
