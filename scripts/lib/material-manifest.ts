import * as fs from "node:fs";
import * as path from "node:path";
import { incrementPatch, pathToRepoRef, readJson, writeJsonAtomic } from "./repository.js";
import { PROJECT_ROOT, MANIFESTS_DIR } from "./config.js";
import { safeProjectSlug } from "./project-paths.js";
import { materialBodySha256 } from "./change-snapshot.js";
import { parseMaterialBundle, MATERIAL_BUNDLE_FILE } from "./material-bundle.js";

export interface IngestionMaterialRecord {
  source_id?: string;
  original_name: string;
  stored_name: string;
  source_type: string | null;
  source_owner: string | null;
  source_time: string | null;
  is_complete: boolean;
  content_bytes?: number;
}

export interface MaterialManifestRecord {
  source_id: string;
  original_ref: string;
  draft_ref: string;
  sha256: string;
  missing_metadata: string[];
  registered_at: string;
}

export interface MaterialIngestionRecord {
  task_id: string;
  task_goal: string;
  updated_at: string;
  materials: IngestionMaterialRecord[];
  structured_material_ref?: string | null;
}

export interface DuplicateMaterialRecord {
  source_id: string;
  sha256: string;
  existing_task_id: string;
  existing_draft_ref: string;
  existing_structured_material_ref?: string | null;
}

export interface MaterialManifest {
  artifact_id: string;
  version: string;
  project_id: string;
  topic: string;
  ingestions: MaterialIngestionRecord[];
  records: MaterialManifestRecord[];
}

/**
 * 材料 manifest 现在存放于 `.cache/manifests/<projectId>/material-manifest.json`。
 * 该文件是纯派生缓存：所有信息可从 `context-workspace/drafts/<projectId>/source-materials/`
 * 下每份 `materials.md` 的 frontmatter 与材料头注释重建。
 *
 * `context-workspace/` 中不再存放 JSON 脚本文件，产品经理只看到 Markdown。
 */
export function materialManifestPath(projectId: string, root = PROJECT_ROOT): string {
  return path.join(root, MANIFESTS_DIR, safeProjectSlug(projectId), "material-manifest.json");
}

/** drafts 项目材料根目录，供冷启动重建扫描使用。 */
function projectDraftsDir(projectId: string, root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/drafts", safeProjectSlug(projectId), "source-materials");
}

export function readMaterialManifest(projectId: string, root = PROJECT_ROOT): {
  manifest: MaterialManifest | null;
  wasLegacy: boolean;
} {
  const manifestPath = materialManifestPath(projectId, root);
  if (!fs.existsSync(manifestPath)) {
    // 缓存缺失：尝试从 drafts/<projectId>/source-materials 反扫重建。
    const rebuilt = rebuildManifestFromDrafts(projectId, root);
    if (rebuilt) {
      writeJsonAtomic(manifestPath, rebuilt);
      return { manifest: rebuilt, wasLegacy: false };
    }
    return { manifest: null, wasLegacy: false };
  }
  const raw = readJson<Record<string, unknown>>(manifestPath);
  const isUnified = Array.isArray(raw.ingestions) && Array.isArray(raw.records);
  return {
    manifest: {
      artifact_id: typeof raw.artifact_id === "string" ? raw.artifact_id : `material-manifest-${safeProjectSlug(projectId)}`,
      version: typeof raw.version === "string" ? raw.version : "0.2.0",
      project_id: typeof raw.project_id === "string" ? raw.project_id : safeProjectSlug(projectId),
      topic: typeof raw.topic === "string" ? raw.topic : safeProjectSlug(projectId),
      ingestions: isUnified ? raw.ingestions as MaterialIngestionRecord[] : [],
      records: Array.isArray(raw.records) ? raw.records as MaterialManifestRecord[] : [],
    },
    wasLegacy: !isUnified,
  };
}

/**
 * 从 drafts/<projectId>/source-materials 下每个任务目录的 materials.md 反扫重建 manifest。
 * 单一真相源：材料 bundle 的 frontmatter + 材料头注释。缓存丢失可零损重建。
 */
export function rebuildManifestFromDrafts(projectId: string, root = PROJECT_ROOT): MaterialManifest | null {
  const draftsDir = projectDraftsDir(projectId, root);
  if (!fs.existsSync(draftsDir)) return null;
  const taskDirs = fs.readdirSync(draftsDir)
    .map((name) => path.join(draftsDir, name))
    .filter((p) => fs.statSync(p).isDirectory());
  if (!taskDirs.length) return null;

  const ingestions: MaterialIngestionRecord[] = [];
  const records: MaterialManifestRecord[] = [];

  for (const taskDir of taskDirs) {
    const bundlePath = path.join(taskDir, MATERIAL_BUNDLE_FILE);
    if (!fs.existsSync(bundlePath)) continue;
    const parsed = parseMaterialBundle(bundlePath);
    if (!parsed.header) continue; // 没有 frontmatter 的旧 bundle 跳过，靠迁移脚本补齐
    const draftRef = pathToRepoRef(bundlePath, root);
    const materials: IngestionMaterialRecord[] = parsed.materials.map((m) => ({
      source_id: m.attrs.source_id,
      original_name: m.attrs.original_name ?? "",
      stored_name: MATERIAL_BUNDLE_FILE,
      source_type: m.attrs.source_type ?? null,
      source_owner: m.attrs.source_owner ?? null,
      source_time: m.attrs.source_time ?? null,
      is_complete: m.attrs.is_complete !== "false",
      content_bytes: Buffer.byteLength(m.content, "utf-8"),
    }));
    ingestions.push({
      task_id: parsed.header.task_id,
      task_goal: parsed.header.task_goal,
      updated_at: parsed.header.updated_at,
      materials,
      structured_material_ref: parsed.header.structured_material_ref ?? null,
    });
    for (const m of parsed.materials) {
      if (!m.attrs.source_id) continue;
      const missing = [
        !m.attrs.source_owner ? "source_owner" : null,
        !m.attrs.source_time ? "source_time" : null,
        !m.attrs.source_type ? "source_type" : null,
      ].filter((v): v is string => v !== null);
      records.push({
        source_id: m.attrs.source_id,
        original_ref: draftRef,
        draft_ref: draftRef,
        sha256: materialBodySha256(m.content),
        missing_metadata: missing,
        registered_at: parsed.header.registered_at || parsed.header.updated_at,
      });
    }
  }

  if (!ingestions.length) return null;
  return {
    artifact_id: `material-manifest-${safeProjectSlug(projectId)}`,
    version: "0.2.0",
    project_id: safeProjectSlug(projectId),
    topic: safeProjectSlug(projectId),
    ingestions,
    records,
  };
}

export function upsertMaterialIngestion(
  projectId: string,
  ingestion: MaterialIngestionRecord,
  topic = projectId,
  root = PROJECT_ROOT,
): string {
  const current = readMaterialManifest(projectId, root);
  const manifest = current.manifest ?? {
    artifact_id: `material-manifest-${safeProjectSlug(projectId)}`,
    version: "0.2.0",
    project_id: safeProjectSlug(projectId),
    topic,
    ingestions: [],
    records: [],
  };
  const existing = manifest.ingestions.findIndex((item) => item.task_id === ingestion.task_id);
  if (existing >= 0) manifest.ingestions[existing] = ingestion;
  else manifest.ingestions.push(ingestion);
  manifest.topic = manifest.topic || topic;
  if (current.manifest && (existing >= 0 || current.wasLegacy)) {
    manifest.version = incrementPatch(manifest.version);
  }
  writeJsonAtomic(materialManifestPath(projectId, root), manifest);
  return pathToRepoRef(materialManifestPath(projectId, root), root);
}

export function updateMaterialIngestionArtifact(
  projectId: string,
  taskId: string,
  structuredMaterialRef: string,
  root = PROJECT_ROOT,
): void {
  const current = readMaterialManifest(projectId, root).manifest;
  const ingestion = current?.ingestions.find((item) => item.task_id === taskId);
  if (!current || !ingestion || ingestion.structured_material_ref === structuredMaterialRef) return;
  ingestion.structured_material_ref = structuredMaterialRef;
  current.version = incrementPatch(current.version);
  writeJsonAtomic(materialManifestPath(projectId, root), current);
  // 同步回 bundle frontmatter，保证冷启动重建能恢复该字段。
  syncStructuredRefToBundle(projectId, taskId, structuredMaterialRef, root);
}

function syncStructuredRefToBundle(
  projectId: string,
  taskId: string,
  structuredMaterialRef: string,
  root: string,
): void {
  const bundlePath = path.join(projectDraftsDir(projectId, root), taskId, MATERIAL_BUNDLE_FILE);
  if (!fs.existsSync(bundlePath)) return;
  const raw = fs.readFileSync(bundlePath, "utf-8");
  if (!raw.startsWith("---\n")) return;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return;
  const header = raw.slice(4, end);
  const rest = raw.slice(end);
  const lines = header.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("structured_material_ref:"));
  const newLine = `structured_material_ref: ${structuredMaterialRef}`;
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(bundlePath, `---\n${lines.join("\n")}${rest}`, "utf-8");
}

export function findDuplicateMaterials(
  projectId: string,
  sourceIds: string[],
  taskId: string,
  root = PROJECT_ROOT,
): DuplicateMaterialRecord[] {
  const manifest = readMaterialManifest(projectId, root).manifest;
  if (!manifest) return [];
  return sourceIds.flatMap((sourceId) => {
    const ingestion = manifest.ingestions.find(
      (item) => item.task_id !== taskId && item.materials.some((material) => material.source_id === sourceId),
    );
    const record = manifest.records.find((item) => item.source_id === sourceId);
    if (!ingestion || !record) return [];
    return [{
      source_id: sourceId,
      sha256: record.sha256,
      existing_task_id: ingestion.task_id,
      existing_draft_ref: record.draft_ref,
      existing_structured_material_ref: ingestion.structured_material_ref,
    }];
  });
}

export function readIngestionMaterialList(
  projectId: string,
  taskId: string,
  sourceDir: string,
  root = PROJECT_ROOT,
): IngestionMaterialRecord[] {
  const unified = readMaterialManifest(projectId, root).manifest?.ingestions.find((item) => item.task_id === taskId);
  const legacyPath = path.join(sourceDir, "ingest-manifest.json");
  const legacy = !unified && fs.existsSync(legacyPath)
    ? readJson<{ materials?: IngestionMaterialRecord[] }>(legacyPath).materials ?? []
    : [];
  const materials = unified?.materials ?? legacy;
  if (!unified && legacy.length) {
    upsertMaterialIngestion(projectId, {
      task_id: taskId,
      task_goal: "",
      updated_at: new Date().toISOString(),
      materials: legacy,
    }, projectId, root);
  }
  return materials.filter((item) =>
    typeof item.stored_name === "string" && typeof item.original_name === "string"
  );
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "default-project";
}
