import * as fs from "node:fs";
import * as path from "node:path";
import { updateProjectIndex, updateRootIndex } from "./index-generator.js";

/**
 * Maintain 维护能力 - 保持索引同步、检测孤立文件、标记陈旧内容
 *
 * 参照 context-engineer 的 Maintain 能力
 */

export interface MaintenanceReport {
  indexSyncIssues: IndexSyncIssue[];
  orphanedFiles: OrphanedFile[];
  staleContent: StaleContent[];
  summary: string;
}

export interface IndexSyncIssue {
  type: 'missing_in_index' | 'missing_file' | 'broken_link';
  filePath: string;
  indexPath: string;
  reason: string;
}

export interface OrphanedFile {
  filePath: string;
  lastModified: Date;
  reason: string;
}

export interface StaleContent {
  filePath: string;
  lastModified: Date;
  daysSinceUpdate: number;
  layer: 'drafts' | 'workspace' | 'context';
  suggestion: string;
}

/**
 * 执行完整的维护检查
 */
export async function performMaintenance(workspaceRoot: string): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    indexSyncIssues: [],
    orphanedFiles: [],
    staleContent: [],
    summary: ''
  };

  // 1. 索引同步检查
  report.indexSyncIssues = await checkIndexSync(workspaceRoot);

  // 2. 孤立文件检测
  report.orphanedFiles = await detectOrphanedFiles(workspaceRoot);

  // 3. 陈旧内容标记
  report.staleContent = await detectStaleContent(workspaceRoot);

  // 生成摘要
  report.summary = generateSummary(report);

  return report;
}

/**
 * 检查索引同步状态
 */
async function checkIndexSync(workspaceRoot: string): Promise<IndexSyncIssue[]> {
  const issues: IndexSyncIssue[] = [];

  // 检查每个层级
  for (const layer of ['drafts', 'workspace', 'context'] as const) {
    const layerPath = path.join(workspaceRoot, layer);

    if (!fs.existsSync(layerPath)) continue;

    // 获取所有项目目录
    const projectDirs = fs.readdirSync(layerPath)
      .filter(name => {
        const fullPath = path.join(layerPath, name);
        return fs.statSync(fullPath).isDirectory() && !name.startsWith('.');
      });

    for (const projectId of projectDirs) {
      const projectPath = path.join(layerPath, projectId);
      const indexPath = path.join(projectPath, 'CLAUDE.md');

      // 检查索引文件是否存在
      if (!fs.existsSync(indexPath)) {
        issues.push({
          type: 'missing_in_index',
          filePath: projectPath,
          indexPath,
          reason: '项目目录缺少 CLAUDE.md 索引文件'
        });
        continue;
      }

      // 读取索引文件
      const indexContent = fs.readFileSync(indexPath, 'utf-8');

      // 获取目录中的所有 .md 文件
      const actualFiles = fs.readdirSync(projectPath)
        .filter(f => f.endsWith('.md') && f !== 'CLAUDE.md' && f !== 'README.md');

      // 检查索引中列出的文件是否存在
      const indexedFiles = extractIndexedFiles(indexContent);

      for (const indexedFile of indexedFiles) {
        const filePath = path.join(projectPath, indexedFile);
        if (!fs.existsSync(filePath)) {
          issues.push({
            type: 'missing_file',
            filePath,
            indexPath,
            reason: '索引中的文件不存在'
          });
        }
      }

      // 检查实际文件是否在索引中
      for (const actualFile of actualFiles) {
        if (!indexedFiles.includes(actualFile)) {
          issues.push({
            type: 'missing_in_index',
            filePath: path.join(projectPath, actualFile),
            indexPath,
            reason: '文件未在索引中列出'
          });
        }
      }
    }
  }

  return issues;
}

/**
 * 从索引内容中提取已索引的文件列表
 */
function extractIndexedFiles(indexContent: string): string[] {
  const files: string[] = [];
  const lines = indexContent.split('\n');

  for (const line of lines) {
    // 匹配格式：- **[filename.md](filename.md)** — ...
    const match = line.match(/- \*\*\[([\w\-一-龥]+\.md)\]/);
    if (match) {
      files.push(match[1]);
    }
  }

  return files;
}

/**
 * 检测孤立文件（未在索引中的文件）
 */
async function detectOrphanedFiles(workspaceRoot: string): Promise<OrphanedFile[]> {
  const orphaned: OrphanedFile[] = [];

  // 这个功能与 checkIndexSync 的 missing_in_index 重叠
  // 在实际使用中，可以从 checkIndexSync 的结果中提取

  return orphaned;
}

/**
 * 检测陈旧内容
 */
async function detectStaleContent(workspaceRoot: string): Promise<StaleContent[]> {
  const stale: StaleContent[] = [];
  const now = Date.now();

  // 检查 drafts 和 workspace
  for (const layer of ['drafts', 'workspace'] as const) {
    const layerPath = path.join(workspaceRoot, layer);

    if (!fs.existsSync(layerPath)) continue;

    // 遍历所有项目
    const projectDirs = fs.readdirSync(layerPath)
      .filter(name => {
        const fullPath = path.join(layerPath, name);
        return fs.statSync(fullPath).isDirectory() && !name.startsWith('.');
      });

    for (const projectId of projectDirs) {
      const projectPath = path.join(layerPath, projectId);

      // 获取所有 .md 文件
      const files = fs.readdirSync(projectPath)
        .filter(f => f.endsWith('.md') && f !== 'CLAUDE.md' && f !== 'README.md');

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const stats = fs.statSync(filePath);
        const daysSince = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);

        // drafts 超过 30 天
        if (layer === 'drafts' && daysSince > 30) {
          stale.push({
            filePath,
            lastModified: stats.mtime,
            daysSinceUpdate: Math.round(daysSince),
            layer,
            suggestion: '考虑提升到 workspace 或删除'
          });
        }

        // workspace 超过 90 天
        if (layer === 'workspace' && daysSince > 90) {
          stale.push({
            filePath,
            lastModified: stats.mtime,
            daysSinceUpdate: Math.round(daysSince),
            layer,
            suggestion: '任务可能已完成或放弃，考虑归档或提升到 context'
          });
        }
      }
    }
  }

  return stale;
}

/**
 * 生成维护报告摘要
 */
function generateSummary(report: MaintenanceReport): string {
  const parts: string[] = [];

  if (report.indexSyncIssues.length > 0) {
    parts.push(`发现 ${report.indexSyncIssues.length} 个索引同步问题`);
  }

  if (report.orphanedFiles.length > 0) {
    parts.push(`发现 ${report.orphanedFiles.length} 个孤立文件`);
  }

  if (report.staleContent.length > 0) {
    parts.push(`发现 ${report.staleContent.length} 个陈旧内容`);
  }

  if (parts.length === 0) {
    return '✅ 所有检查通过，无需维护';
  }

  return '⚠️ ' + parts.join('，');
}

/**
 * 自动修复索引同步问题
 */
export async function autoFixIndexSync(workspaceRoot: string): Promise<number> {
  const issues = await checkIndexSync(workspaceRoot);
  let fixed = 0;

  // 按项目分组
  const byProject = new Map<string, IndexSyncIssue[]>();

  for (const issue of issues) {
    const projectPath = path.dirname(issue.indexPath);
    const existing = byProject.get(projectPath) || [];
    existing.push(issue);
    byProject.set(projectPath, existing);
  }

  // 对每个有问题的项目重新生成索引
  for (const [projectPath, projectIssues] of byProject) {
    try {
      // 提取 project_id 和 layer
      const parts = projectPath.split(path.sep);
      const layerIndex = parts.findIndex(p => ['drafts', 'workspace', 'context'].includes(p));

      if (layerIndex === -1) continue;

      const layer = parts[layerIndex] as 'drafts' | 'workspace' | 'context';
      const projectId = parts[layerIndex + 1];

      // 重新生成索引
      updateProjectIndex(projectId, layer, workspaceRoot);
      fixed += projectIssues.length;
    } catch (error) {
      console.error(`修复索引失败: ${projectPath}`, error);
    }
  }

  return fixed;
}

/**
 * 生成维护报告（Markdown格式）
 */
export function formatMaintenanceReport(report: MaintenanceReport): string {
  const lines: string[] = [
    '# 维护报告',
    '',
    report.summary,
    ''
  ];

  if (report.indexSyncIssues.length > 0) {
    lines.push('## 索引同步问题', '');
    for (const issue of report.indexSyncIssues) {
      lines.push(`- **${issue.type}**: ${issue.filePath}`);
      lines.push(`  - 理由: ${issue.reason}`);
      lines.push('');
    }
  }

  if (report.staleContent.length > 0) {
    lines.push('## 陈旧内容', '');
    for (const stale of report.staleContent) {
      lines.push(`- **${stale.filePath}**`);
      lines.push(`  - 最后更新: ${stale.daysSinceUpdate} 天前`);
      lines.push(`  - 建议: ${stale.suggestion}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
