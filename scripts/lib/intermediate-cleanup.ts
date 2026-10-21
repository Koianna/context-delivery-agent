import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_RUNS_DIR, PROJECT_ROOT } from "./config.js";
import { taskSlug } from "./repository.js";

export interface IntermediateDir {
  dir: string;
  label: "provider-output" | "agent-runs";
}

/**
 * 任务中间目录回收（GC）。
 *
 * 背景：每次任务运行会把 provider 的中间产物写到两个按任务隔离的目录里，
 * 任务进入终态后这些文件不再被读取，若不回收会持续堆积：
 *   - runtime/provider-output/<task>/  纯 provider 按任务 scratch，终态后可安全删除
 *   - .cache/agent-runs/<task>/         runs:// 派生命名空间，含决策账本/审核报告等交付物
 *
 * 自动回收只清理 provider-output；agent-runs 因含业务交付物，只通过手动命令清理。
 * .cache/prd-recovery/（灾备）与 .cache/manifests/（可重建缓存）不在此处处理。
 */

/** 返回某任务可能占用的中间目录（含 provider-output 与 agent-runs）。 */
export function taskIntermediateDirs(taskId: string, root = PROJECT_ROOT): IntermediateDir[] {
  const slug = taskSlug(taskId);
  return [
    { dir: path.join(root, "runtime/provider-output", slug), label: "provider-output" },
    { dir: path.join(root, AGENT_RUNS_DIR, slug), label: "agent-runs" },
  ];
}

function removeDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  fs.rmSync(dir, { recursive: true, force: true });
  return [dir];
}

/** 删除某任务的 provider 中间产物（终态后安全）。返回已删除的目录路径。 */
export function cleanupProviderOutput(taskId: string, root = PROJECT_ROOT): string[] {
  return removeDir(path.join(root, "runtime/provider-output", taskSlug(taskId)));
}

/** 删除某任务的 runs:// 派生目录（含决策账本/审核报告，谨慎使用）。返回已删除的目录路径。 */
export function cleanupAgentRuns(taskId: string, root = PROJECT_ROOT): string[] {
  return removeDir(path.join(root, AGENT_RUNS_DIR, taskSlug(taskId)));
}

/** 列出 runtime/provider-output/ 下所有任务目录，按修改时间倒序。 */
export function listProviderOutputDirs(root = PROJECT_ROOT): Array<{ slug: string; dir: string; mtimeMs: number }> {
  const base = path.join(root, "runtime/provider-output");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(base, entry.name);
      return { slug: entry.name, dir, mtimeMs: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
