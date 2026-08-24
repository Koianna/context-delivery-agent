#!/usr/bin/env npx tsx
/**
 * 一次性迁移：把每个项目 context-workspace/drafts/<projectId>/material-manifest.json
 * 中的 B 类字段（task_goal / original_name / source_owner / source_time / source_type /
 * registered_at / structured_material_ref）反写进对应任务目录的 materials.md 顶部
 * frontmatter 与材料头注释，然后：
 * - 把 manifest 移到 .cache/manifests/<projectId>/material-manifest.json
 * - 删除 context-workspace/drafts/<projectId>/material-manifest.json
 * - 生成 drafts/<projectId>/README.md
 *
 * 幂等：可重复运行；若 bundle 已带 frontmatter 则跳过写入以避免覆盖。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "../lib/config.js";
import { materialManifestPath, readMaterialManifest, type MaterialManifest } from "../lib/material-manifest.js";
import { refreshDraftsReadme } from "../lib/material-index.js";
import { MATERIAL_BUNDLE_FILE } from "../lib/material-bundle.js";
import { renderFrontmatter, writeJsonAtomic } from "../lib/repository.js";
import { safeProjectSlug } from "../lib/project-paths.js";

const DRAFTS_ROOT = path.join(PROJECT_ROOT, "context-workspace/drafts");

function main() {
  if (!fs.existsSync(DRAFTS_ROOT)) {
    console.log("No drafts directory. Nothing to migrate.");
    return;
  }
  const projects = fs.readdirSync(DRAFTS_ROOT)
    .filter((name) => fs.statSync(path.join(DRAFTS_ROOT, name)).isDirectory());

  for (const projectId of projects) {
    const legacyManifestPath = path.join(DRAFTS_ROOT, projectId, "material-manifest.json");
    if (!fs.existsSync(legacyManifestPath)) {
      console.log(`[skip] ${projectId}: no legacy manifest`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(legacyManifestPath, "utf-8")) as MaterialManifest;
    console.log(`[migrate] ${projectId}: ${raw.ingestions?.length ?? 0} ingestions`);

    for (const ingestion of raw.ingestions ?? []) {
      backfillBundle(projectId, ingestion, raw);
    }

    // 把 manifest 移到 .cache/manifests/<projectId>/material-manifest.json
    const newPath = materialManifestPath(projectId, PROJECT_ROOT);
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    writeJsonAtomic(newPath, raw);
    fs.rmSync(legacyManifestPath);
    console.log(`  moved manifest to ${path.relative(PROJECT_ROOT, newPath)}`);

    // 验证冷启动能读回等价的 manifest
    const rebuilt = readMaterialManifest(projectId, PROJECT_ROOT).manifest;
    if (!rebuilt) {
      console.warn(`  ⚠ rebuild returned null for ${projectId}`);
    } else {
      console.log(`  rebuild ok: ${rebuilt.ingestions.length} ingestions, ${rebuilt.records.length} records`);
    }

    // 生成 README.md
    refreshDraftsReadme(projectId, PROJECT_ROOT);
    console.log(`  README.md generated`);
  }
}

function backfillBundle(projectId: string, ingestion: MaterialManifest["ingestions"][number], manifest: MaterialManifest): void {
  const bundlePath = path.join(DRAFTS_ROOT, safeProjectSlug(projectId), "source-materials", ingestion.task_id, MATERIAL_BUNDLE_FILE);
  if (!fs.existsSync(bundlePath)) {
    console.warn(`    ⚠ missing bundle ${bundlePath}`);
    return;
  }
  const raw = fs.readFileSync(bundlePath, "utf-8");
  if (raw.startsWith("---\n")) {
    console.log(`    ${ingestion.task_id}: bundle already has frontmatter, skipping`);
    return;
  }

  const firstRecord = manifest.records?.find((r) => ingestion.materials.some((m) => m.source_id === r.source_id));
  const registeredAt = firstRecord?.registered_at ?? ingestion.updated_at;

  // 重写材料头注释成新格式（若旧注释只带 source_id）
  const migratedBody = migrateMaterialComments(raw, ingestion);

  const frontmatter = renderFrontmatter(
    {
      task_id: ingestion.task_id,
      task_goal: ingestion.task_goal || "",
      registered_at: registeredAt,
      updated_at: ingestion.updated_at,
      project_id: projectId,
      structured_material_ref: ingestion.structured_material_ref ?? null,
    },
    migratedBody,
  );
  fs.writeFileSync(bundlePath, frontmatter, "utf-8");
  console.log(`    ${ingestion.task_id}: frontmatter + comments backfilled`);
}

function migrateMaterialComments(bundleText: string, ingestion: MaterialManifest["ingestions"][number]): string {
  return bundleText.replace(
    /<!-- context-material: ([a-zA-Z0-9_-]+) -->/g,
    (_all, sourceId: string) => {
      const material = ingestion.materials.find((m) => m.source_id === sourceId);
      if (!material) return `<!-- context-material: source_id=${sourceId} -->`;
      const parts = [`source_id=${sourceId}`];
      if (material.original_name) parts.push(`original_name=${escape(material.original_name)}`);
      if (material.source_type) parts.push(`source_type=${escape(material.source_type)}`);
      if (material.source_owner) parts.push(`source_owner=${escape(material.source_owner)}`);
      if (material.source_time) parts.push(`source_time=${escape(material.source_time)}`);
      parts.push(`is_complete=${material.is_complete ? "true" : "false"}`);
      return `<!-- context-material: ${parts.join(" | ")} -->`;
    },
  );
}

function escape(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/-->/g, "--&gt;");
}

main();
