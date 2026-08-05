#!/usr/bin/env npx tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import type { MaterialIngestInput } from "./lib/context-types.js";
import {
  incrementPatch,
  pathToRepoRef,
  readJson,
  repoRefToPath,
  writeJsonAtomic,
  writeTextAtomic,
} from "./lib/repository.js";

interface MaterialManifestRecord {
  source_id: string;
  original_ref: string;
  draft_ref: string;
  sha256: string;
  missing_metadata: string[];
  registered_at: string;
}

interface MaterialManifest {
  artifact_id: string;
  version: string;
  task_goal: string;
  topic: string;
  records: MaterialManifestRecord[];
}

export function registerMaterials(inputPath: string, root = PROJECT_ROOT, projectId?: string) {
  const input = readJson<MaterialIngestInput>(inputPath);
  const allowed = new Set(input.analysis_scope.included_source_ids);
  const workspaceSlug = projectId ?? input.workspace_slug ?? input.project_id ?? "default-project";
  const targetDir = path.join(root, "context-workspace/drafts", safeSlug(workspaceSlug));
  const sourceRoot = path.join(targetDir, "source-materials");
  const manifestPath = path.join(targetDir, "material-manifest.json");
  const existing = fs.existsSync(manifestPath)
    ? readJson<MaterialManifest>(manifestPath)
    : null;

  const incomingRecords = input.materials.map((material) => {
    if (!allowed.has(material.source_id)) {
      throw new Error(`材料不在 analysis_scope 中: ${material.source_id}`);
    }
    const sourcePath = repoRefToPath(material.content_ref, root);
    if (!fs.existsSync(sourcePath)) throw new Error(`材料不存在: ${material.content_ref}`);
    const content = fs.readFileSync(sourcePath, "utf-8");
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

    return {
      source_id: material.source_id,
      original_ref: material.content_ref,
      draft_ref: pathToRepoRef(targetPath, root),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      missing_metadata: missingMetadata,
      registered_at: new Date().toISOString(),
    };
  });

  const records = [...(existing?.records ?? [])];
  let changed = false;
  for (const incoming of incomingRecords) {
    const registered = records.find((record) => record.source_id === incoming.source_id);
    if (!registered) {
      records.push(incoming);
      changed = true;
      continue;
    }
    if (registered.sha256 !== incoming.sha256) {
      throw new Error(`材料 ${incoming.source_id} 与已登记内容哈希冲突`);
    }
    if (registered.draft_ref !== incoming.draft_ref && incoming.draft_ref.includes("/source-materials/")) {
      const index = records.indexOf(registered);
      records[index] = { ...incoming, registered_at: registered.registered_at };
      changed = true;
    }
  }

  const manifest = {
    artifact_id: `material-manifest-${safeSlug(workspaceSlug)}`,
    version: existing && changed ? incrementPatch(existing.version) : existing?.version ?? "0.1.0",
    task_goal: input.task_goal,
    topic: input.analysis_scope.topic,
    records,
  };
  if (!existing || changed) writeJsonAtomic(manifestPath, manifest);
  return {
    manifest_ref: pathToRepoRef(manifestPath, root),
    records: incomingRecords,
    status: changed || !existing ? "UPDATED" as const : "UNCHANGED" as const,
  };
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
