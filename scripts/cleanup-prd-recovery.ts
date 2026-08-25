#!/usr/bin/env node
/**
 * PRD 恢复快照清理工具
 *
 * 用途：删除已完成且不再需要的项目快照，释放磁盘空间
 *
 * 使用方式：
 *   npm run cleanup-prd-recovery              # 列出所有可清理的快照
 *   npm run cleanup-prd-recovery -- --all    # 清理所有已完成任务的快照
 *   npm run cleanup-prd-recovery -- --task <task_id>  # 清理指定任务的快照
 *   npm run cleanup-prd-recovery -- --before <date>   # 清理指定日期前的快照
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PRD_RECOVERY_DIR, PROJECT_ROOT, readTaskState } from "./lib/config.js";
import { readJson } from "./lib/repository.js";
import type { PrdRecoveryManifest } from "./lib/prd-recovery.js";

interface CleanupOptions {
  all?: boolean;
  taskId?: string;
  before?: string;
  dryRun?: boolean;
}

function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2);
  const options: CleanupOptions = { dryRun: true };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--all":
        options.all = true;
        options.dryRun = false;
        break;
      case "--task":
        options.taskId = args[++i];
        options.dryRun = false;
        break;
      case "--before":
        options.before = args[++i];
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
    }
  }

  return options;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shouldClean(
  manifest: PrdRecoveryManifest,
  options: CleanupOptions,
  currentTaskId: string | null
): boolean {
  // 保护当前正在运行的任务
  if (manifest.entries.some((entry) => entry.task_id === currentTaskId)) {
    return false;
  }

  if (options.all) return true;

  if (options.taskId) {
    return manifest.entries.some((entry) => entry.task_id === options.taskId);
  }

  if (options.before) {
    const beforeDate = new Date(options.before);
    return manifest.entries.every((entry) => new Date(entry.created_at) < beforeDate);
  }

  return false;
}

async function main() {
  const options = parseArgs();
  const recoveryBase = path.join(PROJECT_ROOT, PRD_RECOVERY_DIR);

  if (!fs.existsSync(recoveryBase)) {
    console.log("✓ 无需清理：prd-recovery 目录不存在");
    return;
  }

  const currentState = readTaskState();
  const currentTaskId = currentState?.task_id ?? null;

  const artifactDirs = fs.readdirSync(recoveryBase, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => ({
      name: item.name,
      path: path.join(recoveryBase, item.name),
      manifestPath: path.join(recoveryBase, item.name, "manifest.json"),
    }))
    .filter((item) => fs.existsSync(item.manifestPath));

  if (artifactDirs.length === 0) {
    console.log("✓ 无需清理：没有找到快照清单");
    return;
  }

  const cleanupCandidates: Array<{
    artifactId: string;
    path: string;
    manifest: PrdRecoveryManifest;
    totalSize: number;
  }> = [];

  for (const dir of artifactDirs) {
    try {
      const manifest = readJson<PrdRecoveryManifest>(dir.manifestPath);

      if (shouldClean(manifest, options, currentTaskId)) {
        const files = fs.readdirSync(dir.path);
        const totalSize = files.reduce((sum, file) => {
          const filePath = path.join(dir.path, file);
          return sum + (fs.statSync(filePath).size || 0);
        }, 0);

        cleanupCandidates.push({
          artifactId: manifest.artifact_id,
          path: dir.path,
          manifest,
          totalSize,
        });
      }
    } catch (error) {
      console.warn(`⚠ 跳过损坏的清单: ${dir.manifestPath}`);
    }
  }

  if (cleanupCandidates.length === 0) {
    console.log("✓ 无需清理：没有符合条件的快照");
    return;
  }

  if (options.dryRun) {
    console.log("📋 可清理的快照（预览模式，不会实际删除）：\n");
  } else {
    console.log("🗑️  准备清理以下快照：\n");
  }

  let totalSize = 0;
  for (const candidate of cleanupCandidates) {
    console.log(`• ${candidate.artifactId}`);
    console.log(`  路径: ${candidate.path}`);
    console.log(`  版本数: ${candidate.manifest.entries.length}`);
    console.log(`  大小: ${formatBytes(candidate.totalSize)}`);
    console.log(`  任务ID: ${[...new Set(candidate.manifest.entries.map((e) => e.task_id))].join(", ")}`);
    console.log();
    totalSize += candidate.totalSize;
  }

  console.log(`总计: ${cleanupCandidates.length} 个快照目录，${formatBytes(totalSize)}`);
  console.log();

  if (options.dryRun) {
    console.log("💡 提示：");
    console.log("  • 添加 --all 参数清理所有已完成任务的快照");
    console.log("  • 添加 --task <task_id> 清理指定任务的快照");
    console.log("  • 添加 --before <date> 清理指定日期前的快照（格式：YYYY-MM-DD）");
    if (currentTaskId) {
      console.log(`  • 当前运行任务 ${currentTaskId} 的快照不会被清理`);
    }
  } else {
    for (const candidate of cleanupCandidates) {
      try {
        fs.rmSync(candidate.path, { recursive: true, force: true });
        console.log(`✓ 已删除: ${candidate.artifactId}`);
      } catch (error) {
        console.error(`✗ 删除失败: ${candidate.artifactId}`, error);
      }
    }
    console.log(`\n✓ 清理完成，释放 ${formatBytes(totalSize)}`);
  }
}

main().catch((error) => {
  console.error("清理失败:", error);
  process.exit(1);
});
