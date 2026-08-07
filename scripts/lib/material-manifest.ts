import * as fs from "node:fs";
import * as path from "node:path";
import { incrementPatch, pathToRepoRef, readJson, writeJsonAtomic } from "./repository.js";
import { PROJECT_ROOT } from "./config.js";
import { safeProjectSlug } from "./project-paths.js";

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

export function materialManifestPath(projectId: string, root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/drafts", safeProjectSlug(projectId), "material-manifest.json");
}

export function readMaterialManifest(projectId: string, root = PROJECT_ROOT): {
  manifest: MaterialManifest | null;
  wasLegacy: boolean;
} {
  const manifestPath = materialManifestPath(projectId, root);
  if (!fs.existsSync(manifestPath)) return { manifest: null, wasLegacy: false };
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
