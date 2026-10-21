#!/usr/bin/env node
/**
 * 运行时中间文件清理工具
 *
 * 用途：回收任务进入终态后不再需要的中间产物，释放磁盘空间。
 *
 * 默认只清理 runtime/provider-output/（provider 按任务 scratch，终态后安全）；
 * .cache/agent-runs/ 含决策账本与审核报告等业务交付物，需显式加 --include-runs 才会清理。
 * .cache/prd-recovery/（灾备）请使用 npm run cleanup:prd-recovery 单独清理。
 *
 * 使用方式：
 *   npm run cleanup:runtime                        # 预览可清理的 provider-output 目录
 *   npm run cleanup:runtime -- --all               # 清理所有已完成任务的 provider-output
 *   npm run cleanup:runtime -- --task <task_id>    # 清理指定任务
 *   npm run cleanup:runtime -- --keep-recent 3     # 只保留最近 3 个任务的 provider-output
 *   npm run cleanup:runtime -- --all --include-runs # 连同 agent-runs 一并清理（谨慎）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readTaskState, PROJECT_ROOT } from "./lib/config.js";
import { taskSlug } from "./lib/repository.js";
import { listProviderOutputDirs } from "./lib/intermediate-cleanup.js";

interface CleanupOptions {
  all: boolean;
  taskId?: string;
  keepRecent?: number;
  includeRuns: boolean;
  dryRun: boolean;
}

const TERMINAL_STATES = new Set(["CONTEXT_TASK_COMPLETED", "DELIVERED", "TASK_CANCELLED"]);

function parseArgs(): CleanupOptions {
  const args = process.argv.slice(2);
  const options: CleanupOptions = { all: false, includeRuns: false, dryRun: true };

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
      case "--keep-recent":
        options.keepRecent = Number(args[++i]);
        options.dryRun = false;
        break;
      case "--include-runs":
        options.includeRuns = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
    }
  }

  return options;
}

interface Target {
  slug: string;
  dir: string;
  runs: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += fs.statSync(full).size;
    }
  }
  return total;
}

function listAgentRunsDirs(): Target[] {
  const runsBase = path.join(PROJECT_ROOT, ".cache/agent-runs");
  if (!fs.existsSync(runsBase)) return [];
  return fs.readdirSync(runsBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ slug: entry.name, dir: path.join(runsBase, entry.name), runs: true }));
}

function main() {
  const options = parseArgs();
  const state = readTaskState();
  const activeSlug = state && !TERMINAL_STATES.has(state.current_state) ? taskSlug(state.task_id) : null;

  // 候选集：provider-output 目录（始终），agent-runs 目录（仅 --include-runs）
  const providerDirs = listProviderOutputDirs().map((item) => ({ slug: item.slug, dir: item.dir, runs: false }));
  const runDirs = options.includeRuns ? listAgentRunsDirs() : [];
  const allTargets = [...providerDirs, ...runDirs];

  // 过滤：始终保护当前活动任务的目录
  let targets = allTargets.filter((item) => item.slug !== activeSlug);

  if (options.taskId) {
    const slug = taskSlug(options.taskId);
    targets = targets.filter((item) => item.slug === slug);
  } else if (options.keepRecent !== undefined && !options.all) {
    // 只保留最近 N 个 provider-output；agent-runs 不参与 keep-recent 计数
    const keep = options.keepRecent;
    const provider = targets.filter((item) => !item.runs);
    const drop = provider.slice(keep);
    targets = [...drop, ...targets.filter((item) => item.runs)];
  }

  // 无 --all / --task / --keep-recent 时：只预览，不执行
  const willDelete = options.all || options.taskId !== undefined || options.keepRecent !== undefined;
  const dryRun = options.dryRun || !willDelete;

  if (targets.length === 0) {
    console.log("✓ 无需清理：没有符合条件的中间目录");
    return;
  }

  const totalSize = targets.reduce((sum, item) => sum + dirSize(item.dir), 0);
  console.log(dryRun ? "📋 可清理的中间目录（预览模式，不会实际删除）：\n" : "🗑️  准备清理以下中间目录：\n");
  for (const item of targets) {
    console.log(`• ${item.runs ? "[agent-runs]" : "[provider-output]"} ${item.slug}`);
    console.log(`  路径: ${item.dir}`);
    console.log(`  大小: ${formatBytes(dirSize(item.dir))}`);
    console.log();
  }
  console.log(`总计: ${targets.length} 个目录，${formatBytes(totalSize)}`);
  console.log();

  if (dryRun) {
    console.log("💡 提示：");
    console.log("  • 添加 --all 清理所有已完成任务的 provider-output");
    console.log("  • 添加 --task <task_id> 清理指定任务");
    console.log("  • 添加 --keep-recent <N> 只保留最近 N 个任务的 provider-output");
    console.log("  • 添加 --include-runs 连同 .cache/agent-runs/ 一并清理（含决策账本/审核报告，谨慎）");
    if (activeSlug) console.log(`  • 当前活动任务 ${activeSlug} 的目录不会被清理`);
  } else {
    for (const item of targets) {
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
        console.log(`✓ 已删除: ${item.slug}${item.runs ? "（agent-runs）" : ""}`);
      } catch (error) {
        console.error(`✗ 删除失败: ${item.slug}`, error);
      }
    }
    console.log(`\n✓ 清理完成，释放 ${formatBytes(totalSize)}`);
  }
}

main();
