import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { safeProjectSlug } from "./project-paths.js";
import { readMaterialManifest, type MaterialIngestionRecord } from "./material-manifest.js";
import { pathToRepoRef, writeTextAtomic } from "./repository.js";

/**
 * 项目材料清单 README，位于 context-workspace/drafts/<projectId>/README.md。
 *
 * 完全从 manifest（若无则从 bundle frontmatter 自动重建）派生。产品经理打开
 * README 即可看到该项目已接入的材料时间线、原名、原文与整理稿链接，不需要
 * 阅读 JSON。手动删除后下次运行会自动重建。
 */
export function draftsReadmePath(projectId: string, root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/drafts", safeProjectSlug(projectId), "README.md");
}

export function refreshDraftsReadme(projectId: string, root = PROJECT_ROOT): void {
  const manifest = readMaterialManifest(projectId, root).manifest;
  if (!manifest) return;
  const readmePath = draftsReadmePath(projectId, root);
  const projectDir = path.dirname(readmePath);
  if (!fs.existsSync(projectDir)) return;

  const readme = renderReadme(projectId, manifest.ingestions, projectDir, root);
  writeTextAtomic(readmePath, readme);
}

function renderReadme(
  projectId: string,
  ingestions: MaterialIngestionRecord[],
  projectDir: string,
  root: string,
): string {
  const sorted = [...ingestions].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const rows = sorted.map((ing) => renderRow(ing, projectDir, root)).join("\n");
  const totalMaterials = ingestions.reduce((sum, ing) => sum + ing.materials.length, 0);
  const lastUpdated = sorted[0]?.updated_at ?? "";
  const dateOnly = lastUpdated ? lastUpdated.slice(0, 10) : "";

  return [
    `# ${projectId} · 材料清单`,
    "",
    `_由 Runtime 自动维护，产品经理可直接阅读，无需修改。最近更新：${dateOnly || "尚无"}。_`,
    "",
    `- 项目：\`${projectId}\``,
    `- 已接入任务数：${ingestions.length}`,
    `- 材料总数：${totalMaterials}`,
    "",
    "## 材料时间线",
    "",
    "| 接入时间 | 任务目标 | 材料 | 原文 | 整理稿 |",
    "| --- | --- | --- | --- | --- |",
    rows || "| — | 尚无材料 | — | — | — |",
    "",
    "## 说明",
    "",
    "- **原文**：产品经理提交的原始材料（含任务级 frontmatter 与每条材料的头注释）。",
    "- **整理稿**：Runtime 生成的可阅读整理版，发布在 `workspace/projects/<项目>/materials/`。",
    "- 此 README 由系统从 `materials.md` 的头部元信息自动生成，删除后下次运行会重新写入。",
    "",
  ].join("\n");
}

function renderRow(ingestion: MaterialIngestionRecord, projectDir: string, root: string): string {
  const date = ingestion.updated_at ? ingestion.updated_at.slice(0, 16).replace("T", " ") : "—";
  const goal = escapeCell(ingestion.task_goal || "—");
  const names = ingestion.materials.map((m) => escapeCell(m.original_name || "—")).join("<br>") || "—";
  const originalLink = relativeLink(
    path.join(projectDir, "source-materials", ingestion.task_id, "materials.md"),
    projectDir,
  );
  const structuredLink = ingestion.structured_material_ref
    ? relativeLink(refToPath(ingestion.structured_material_ref, root), projectDir)
    : "—";
  return `| ${date} | ${goal} | ${names} | ${originalLink} | ${structuredLink} |`;
}

function relativeLink(target: string, fromDir: string): string {
  if (!fs.existsSync(target)) return "—";
  const rel = path.relative(fromDir, target).split(path.sep).join("/");
  return `[打开](${rel})`;
}

function refToPath(ref: string, root: string): string {
  if (!ref.startsWith("repo://")) return "";
  return path.join(root, ref.slice("repo://".length));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** 供路径反查的对称 helper。 */
export function pathToRef(filePath: string, root = PROJECT_ROOT): string {
  return pathToRepoRef(filePath, root);
}
