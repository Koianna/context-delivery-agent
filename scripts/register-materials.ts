#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import { materialBodySha256 } from "./lib/change-snapshot.js";
import { readMaterialContent } from "./lib/material-bundle.js";
import { materialManifestPath, readMaterialManifest, type DuplicateMaterialRecord, type MaterialManifest, type MaterialManifestRecord } from "./lib/material-manifest.js";
import { safeProjectSlug } from "./lib/project-paths.js";
import type { MaterialIngestInput } from "./lib/context-types.js";
import {
  incrementPatch,
  pathToRepoRef,
  readJson,
  repoRefToPath,
  writeJsonAtomic,
  writeTextAtomic,
} from "./lib/repository.js";

export interface RegisterMaterialsOptions {
  /** 允许对已登记材料做内容修订（哈希冲突时不再抛错，而是保存旧版快照并更新记录） */
  allowRevision?: boolean;
  /** 本次修订的原因，写入修订记录与快照 */
  revisionReason?: string;
}

export function registerMaterials(
  inputPath: string,
  root = PROJECT_ROOT,
  projectId?: string,
  taskId?: string,
  options: RegisterMaterialsOptions = {},
) {
  const input = readJson<MaterialIngestInput>(inputPath);
  const allowed = new Set(input.analysis_scope.included_source_ids);
  const workspaceSlug = projectId ?? input.workspace_slug ?? input.project_id ?? "default-project";
  safeProjectSlug(workspaceSlug);
  const targetDir = path.join(root, "context-workspace/drafts", safeSlug(workspaceSlug));
  const sourceRoot = path.join(targetDir, "source-materials");
  const manifestPath = materialManifestPath(workspaceSlug, root);
  const existingResult = readMaterialManifest(workspaceSlug, root);
  const existing = existingResult.manifest;

  const incomingRecords: MaterialManifestRecord[] = [];
  const incomingNames: string[] = [];
  for (const material of input.materials) {
    if (!allowed.has(material.source_id)) {
      throw new Error(`材料不在 analysis_scope 中: ${material.source_id}`);
    }
    const sourcePath = repoRefToPath(material.content_ref, root);
    if (!fs.existsSync(sourcePath)) throw new Error(`材料不存在: ${material.content_ref}`);
    const content = readMaterialContent(material, root);
    const declaredSourceId = content.match(/(?:^|\n)source_id:\s*([^\s]+)\s*(?:\n|$)/)?.[1];
    if (declaredSourceId && declaredSourceId !== material.source_id) {
      throw new Error(`材料 source_id 与清单不一致: ${material.source_id}`);
    }

    const resolvedSourceRoot = path.resolve(sourceRoot);
    const resolvedSourcePath = path.resolve(sourcePath);
    const sourceIsRegistered = resolvedSourcePath.startsWith(resolvedSourceRoot + path.sep);
    const targetPath = sourceIsRegistered
      ? sourcePath
      : path.join(targetDir, safeFileName(material.name));
    if (!sourceIsRegistered) writeTextAtomic(targetPath, content);
    const missingMetadata = [
      !material.source_owner ? "source_owner" : null,
      !material.source_time ? "source_time" : null,
      !material.source_type ? "source_type" : null,
    ].filter((item): item is string => item !== null);

    incomingRecords.push({
      source_id: material.source_id,
      original_ref: material.content_ref,
      draft_ref: pathToRepoRef(targetPath, root),
      sha256: materialBodySha256(content),
      missing_metadata: missingMetadata,
      registered_at: new Date().toISOString(),
    });
    incomingNames.push(material.name);
  }

  const records = [...(existing?.records ?? [])];
  const revisions = [...(existing?.revisions ?? [])];
  const duplicateRecords: DuplicateMaterialRecord[] = [];
  let changed = false;
  for (let incomingIndex = 0; incomingIndex < incomingRecords.length; incomingIndex++) {
    const incoming = incomingRecords[incomingIndex];
    const incomingName = incomingNames[incomingIndex];
    const registered = records.find((record) => record.source_id === incoming.source_id);
    const priorIngestion = existing?.ingestions.find((item) => item.materials.some((material) => material.source_id === incoming.source_id));
    const duplicate = priorIngestion && priorIngestion.task_id !== (taskId ?? "")
      ? {
        source_id: incoming.source_id,
        sha256: incoming.sha256,
        existing_task_id: priorIngestion.task_id,
        existing_draft_ref: registered?.draft_ref ?? pathToRepoRef(
          path.join(targetDir, "source-materials", safeSlug(priorIngestion.task_id), priorIngestion.materials.find((material) => material.source_id === incoming.source_id)?.stored_name ?? "material.md"),
          root,
        ),
        existing_structured_material_ref: priorIngestion.structured_material_ref,
      } satisfies DuplicateMaterialRecord
      : null;
    if (duplicate) duplicateRecords.push(duplicate);

    // 同名修订：incoming 的 source_id 是内容哈希，内容一变 source_id 就变，
    // 因此"修改已登记材料"表现为"新 source_id + 同名"。允许修订时，若按名称
    // 找到已登记的同名材料且内容确实不同，则视为对它的修订：
    // 保存旧版快照 → 用 incoming 替换旧记录 → 记一条修订历史。
    if (!registered && options.allowRevision && incomingName) {
      const sameName = findSameNameRegistered(existing, incomingName, root, incoming.source_id);
      if (sameName && sameName.sha256 !== incoming.sha256) {
        const snapshotRef = saveMaterialRevisionSnapshot(root, targetDir, sameName, incoming, taskId ?? "revise");
        revisions.push({
          source_id: incoming.source_id,
          previous_source_id: sameName.source_id,
          task_id: taskId ?? "revise",
          previous_sha256: sameName.sha256,
          sha256: incoming.sha256,
          snapshot_ref: snapshotRef,
          reason: options.revisionReason ?? "",
          created_at: new Date().toISOString(),
        });
        const index = records.indexOf(sameName);
        records[index] = { ...incoming, registered_at: sameName.registered_at };
        changed = true;
        continue;
      }
    }

    if (!registered) {
      records.push(incoming);
      changed = true;
      continue;
    }
    if (registered.sha256 !== incoming.sha256) {
      if (options.allowRevision) {
        // 修订已登记材料：先保存旧版快照，再更新记录
        const snapshotRef = saveMaterialRevisionSnapshot(root, targetDir, registered, incoming, taskId ?? "revise");
        revisions.push({
          source_id: incoming.source_id,
          previous_source_id: registered.source_id,
          task_id: taskId ?? "revise",
          previous_sha256: registered.sha256,
          sha256: incoming.sha256,
          snapshot_ref: snapshotRef,
          reason: options.revisionReason ?? "",
          created_at: new Date().toISOString(),
        });
        const index = records.indexOf(registered);
        records[index] = { ...incoming, registered_at: registered.registered_at };
        changed = true;
        continue;
      }
      throw new Error(`材料 ${incoming.source_id} 与已登记内容哈希冲突`);
    }
    if (registered.draft_ref !== incoming.draft_ref && incoming.draft_ref.includes("/source-materials/")) {
      const index = records.indexOf(registered);
      records[index] = { ...incoming, registered_at: registered.registered_at };
      changed = true;
    }
  }

  const manifest: MaterialManifest = {
    artifact_id: `material-manifest-${safeSlug(workspaceSlug)}`,
    version: existing && (changed || existingResult.wasLegacy) ? incrementPatch(existing.version) : existing?.version ?? "0.2.0",
    project_id: safeSlug(workspaceSlug),
    topic: input.analysis_scope.topic,
    ingestions: existing?.ingestions ?? [],
    records,
    revisions,
  };
  if (!existing || changed || existingResult.wasLegacy) writeJsonAtomic(manifestPath, manifest);
  return {
    manifest_ref: pathToRepoRef(manifestPath, root),
    records: incomingRecords,
    duplicate_records: duplicateRecords,
    status: changed || !existing ? "UPDATED" as const : "UNCHANGED" as const,
  };
}

/**
 * \u5728\u5df2\u767b\u8bb0\u6e05\u5355\u91cc\u6309\u6750\u6599\u540d\u627e\u5230\u5bf9\u5e94\u7684\u8bb0\u5f55\u3002
 * \u4fee\u8ba2\u573a\u666f\u4e0b incoming \u7684 source_id \u662f\u65b0\u5185\u5bb9\u54c8\u5e0c\uff0c\u4e0e\u539f\u8bb0\u5f55\u4e0d\u540c\uff0c
 * \u9700\u8981\u901a\u8fc7 original_name \u5173\u8054\u5230"\u540c\u4e00\u4efd\u6750\u6599"\u7684\u65e7\u8bb0\u5f55\u3002
 */
function findSameNameRegistered(
  existing: MaterialManifest | null,
  name: string,
  root: string,
  excludeSourceId?: string,
): MaterialManifestRecord | null {
  if (!existing || !name) return null;
  // 1. 优先从 ingestions 的 original_name 关联（真实 orchestrator 流程会先 upsertMaterialIngestion）
  //    必须排除自身 source_id：修订版先被 upsert 进 ingestions，否则会匹配到"自己"而非旧版。
  for (const ingestion of existing.ingestions) {
    const material = ingestion.materials.find(
      (m) => m.original_name === name && m.source_id !== excludeSourceId,
    );
    if (!material?.source_id) continue;
    const record = existing.records.find((r) => r.source_id === material.source_id);
    if (record) return record;
  }
  // 2. fallback：从 records 的 draft_ref 文件反查 material 头注释里的 original_name
  //    覆盖独立调用 registerMaterials（未先写 ingestions）的场景。
  for (const record of existing.records) {
    if (record.source_id === excludeSourceId) continue;
    const sourcePath = repoRefToPath(record.draft_ref, root);
    if (!fs.existsSync(sourcePath)) continue;
    const content = fs.readFileSync(sourcePath, "utf-8");
    const originalName = content.match(/original_name=([^|\s]+)/)?.[1];
    if (originalName && originalName === name) return record;
  }
  return null;
}

/**
 * \u628a\u5df2\u767b\u8bb0\u6750\u6599\u7684\u65e7\u7248\u5185\u5bb9\u4fdd\u5b58\u4e3a\u5feb\u7167\uff0c\u4f9b\u53ef\u8ffd\u6eaf\u7684\u4fee\u8ba2\u5ba1\u8ba1\u3002
 * \u8def\u5f84\uff1acontext-workspace/drafts/<project>/source-materials/versions/<source_id>/<timestamp>.md
 */
function saveMaterialRevisionSnapshot(
  root: string,
  targetDir: string,
  registered: MaterialManifestRecord,
  incoming: MaterialManifestRecord,
  taskId: string,
): string {
  const versionsDir = path.join(targetDir, "source-materials", "versions", safeFileName(registered.source_id));
  fs.mkdirSync(versionsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(versionsDir, `${timestamp}.md`);
  const sourcePath = repoRefToPath(registered.draft_ref, root);
  const content = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf-8") : "";
  // \u5728\u5feb\u7167\u91cc\u8bb0\u5f55\u4fee\u8ba2\u4e0a\u4e0b\u6587\uff0c\u65b9\u4fbf\u56de\u6eaf
  const header = [
    "---",
    `source_id: ${registered.source_id}`,
    `previous_sha256: ${registered.sha256}`,
    `new_sha256: ${incoming.sha256}`,
    `task_id: ${taskId}`,
    "---",
    "",
  ].join("\n");
  writeTextAtomic(snapshotPath, `${header}${content}`);
  return pathToRepoRef(snapshotPath, root);
}

function safeFileName(value: string): string {
  const base = path.basename(value.trim()).replace(/[\\/]/g, "-");
  const normalized = base.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") return "material.md";
  return /\.(md|markdown|txt|json)$/i.test(normalized) ? normalized : `${normalized}.md`;
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "default-project";
}

function main() {
  const args = process.argv.slice(2);
  const inputArg = argVal(args, "--input");
  if (!inputArg) {
    console.error("用法: npx tsx scripts/register-materials.ts --input <json>");
    process.exit(1);
  }
  const inputPath = path.isAbsolute(inputArg) ? inputArg : path.join(PROJECT_ROOT, inputArg);
  console.log(JSON.stringify(registerMaterials(inputPath), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
