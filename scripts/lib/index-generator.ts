import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./repository.js";

/**
 * 索引生成器 - 为 context-workspace 生成 CLAUDE.md 索引文件
 *
 * 参照 context-engineer 规范：
 * - 每个目录一个 CLAUDE.md 索引
 * - 索引是 AI 导航的"神经系统"
 * - 包含：目录用途、文件列表、一行摘要、使用规则
 */

export interface IndexEntry {
  fileName: string;
  summary: string;
  updatedAt: string;
}

export interface DirectoryIndexOptions {
  dirPath: string;
  dirName: string;
  purpose: string;
  rules?: string[];
  excludeFiles?: string[];
}

/**
 * 生成目录索引文件（CLAUDE.md）
 */
export function generateDirectoryIndex(options: DirectoryIndexOptions): string {
  const {
    dirPath,
    dirName,
    purpose,
    rules = [],
    excludeFiles = ['CLAUDE.md', 'README.md', '.DS_Store']
  } = options;

  if (!fs.existsSync(dirPath)) {
    // 目录不存在时返回空索引
    return `# ${dirName}

## Purpose
${purpose}

## Files
（目录为空）

${rules.length > 0 ? `## Rules\n${rules.map(r => `- ${r}`).join('\n')}` : ''}
`;
  }

  // 读取目录中的所有 .md 文件
  const allFiles = fs.readdirSync(dirPath);
  const markdownFiles = allFiles
    .filter(f => f.endsWith('.md') && !excludeFiles.includes(f))
    .sort();

  const entries: IndexEntry[] = markdownFiles.map(fileName => {
    const filePath = path.join(dirPath, fileName);
    const summary = extractFileSummary(filePath);
    const stats = fs.statSync(filePath);

    return {
      fileName,
      summary,
      updatedAt: stats.mtime.toISOString().split('T')[0]
    };
  });

  // 构建索引内容
  return `# ${dirName}

## Purpose
${purpose}

## Files
${entries.length > 0
  ? entries.map(e => `- **[${e.fileName}](${e.fileName})** — ${e.summary} (${e.updatedAt})`).join('\n')
  : '（目录为空）'
}

${rules.length > 0 ? `## Rules\n${rules.map(r => `- ${r}`).join('\n')}` : ''}
`;
}

/**
 * 从文件中提取一行摘要
 *
 * 优先级：
 * 1. frontmatter 中的 summary 字段
 * 2. frontmatter 中的 task_goal（对于材料整理稿）
 * 3. 第一个非标题、非引用的段落
 * 4. 第一个标题
 * 5. 默认值
 */
export function extractFileSummary(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { metadata, body } = parseFrontmatter(content);

    // 优先级 1：frontmatter 中的 summary
    if (metadata.summary && typeof metadata.summary === 'string') {
      return metadata.summary.slice(0, 100);
    }

    // 优先级 2：frontmatter 中的 task_goal（材料整理稿）
    if (metadata.task_goal && typeof metadata.task_goal === 'string') {
      return metadata.task_goal.slice(0, 100);
    }

    // 优先级 3：task_history 中最后一条的 summary
    if (Array.isArray(metadata.task_history) && metadata.task_history.length > 0) {
      const lastTask = metadata.task_history[metadata.task_history.length - 1];
      if (typeof lastTask === 'string') {
        try {
          const parsed = JSON.parse(lastTask);
          if (parsed.summary) {
            return parsed.summary.slice(0, 100);
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 优先级 4：第一个非空、非标题、非引用的段落
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('>') &&
        !trimmed.startsWith('-') &&
        !trimmed.startsWith('|') &&
        trimmed.length > 10
      ) {
        return trimmed.slice(0, 100);
      }
    }

    // 优先级 5：第一个标题
    const titleMatch = body.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return titleMatch[1].slice(0, 100);
    }

    // 默认值
    return '（无摘要）';
  } catch (error) {
    return '（读取失败）';
  }
}

/**
 * 生成根索引（context-workspace/CLAUDE.md）
 */
export function generateRootIndex(workspaceRoot: string): string {
  const contextPath = path.join(workspaceRoot, 'context');
  const workspacePath = path.join(workspaceRoot, 'workspace');
  const draftsPath = path.join(workspaceRoot, 'drafts');

  // 扫描 workspace 中的项目列表
  const projectsDir = path.join(workspacePath, 'projects');
  let projects: string[] = [];

  if (fs.existsSync(projectsDir)) {
    projects = fs.readdirSync(projectsDir)
      .filter(p => {
        const stat = fs.statSync(path.join(projectsDir, p));
        return stat.isDirectory() && !p.startsWith('.');
      })
      .sort();
  }

  // 扫描 drafts 中的项目列表
  let draftProjects: string[] = [];

  if (fs.existsSync(draftsPath)) {
    draftProjects = fs.readdirSync(draftsPath)
      .filter(p => {
        const stat = fs.statSync(path.join(draftsPath, p));
        return stat.isDirectory() && !p.startsWith('.');
      })
      .sort();
  }

  // 合并所有项目（去重）
  const allProjects = Array.from(new Set([...projects, ...draftProjects])).sort();

  return `# Context Workspace

> 项目材料工作区 - 三层生命周期管理

## Directory Structure

| Directory | Purpose | Layer |
|-----------|---------|-------|
| \`context/\` | 已确认的知识 | 高可信度 |
| \`workspace/\` | 进行中的工作 | 中可信度 |
| \`drafts/\` | 正在形成的想法 | 低可信度 |

## Lifecycle

\`\`\`
drafts/      → 原始材料、初步想法
  ↓ 人工确认
workspace/   → 正在进行的任务、PRD
  ↓ CP-C01 确认
context/     → 已验证的稳定知识
\`\`\`

## Current Projects

${allProjects.length > 0
  ? allProjects.map(p => {
      // 检查项目在哪些层级存在
      const inDrafts = fs.existsSync(path.join(draftsPath, p, 'CLAUDE.md'));
      const inWorkspace = fs.existsSync(path.join(projectsDir, p, 'CLAUDE.md'));

      const layers: string[] = [];
      if (inDrafts) layers.push('[drafts](drafts/' + p + '/CLAUDE.md)');
      if (inWorkspace) layers.push('[workspace](workspace/projects/' + p + '/CLAUDE.md)');

      return `- **${p}** — ${layers.join(' | ')}`;
    }).join('\n')
  : '（暂无项目）'
}

## Rules

- **不自动提升**：层级提升需要人工确认
- **When in doubt, drafts**：不确定时放 drafts
- **索引必须同步**：文件增删后更新索引
- **原文保留**：原始材料归档在 \`.source-materials/\`

## How to Use

- 当 AI 需要了解产品业务时 → 读 \`context/\`
- 当 AI 需要了解正在做什么时 → 读 \`workspace/\`
- 当提供新材料时 → 先放 \`drafts/\`，确认后提升
`;
}

/**
 * 更新项目目录索引
 */
export function updateProjectIndex(
  projectId: string,
  layer: 'drafts' | 'workspace' | 'context',
  workspaceRoot: string
): void {
  const layerPath = layer === 'workspace'
    ? path.join(workspaceRoot, 'workspace', 'projects')
    : path.join(workspaceRoot, layer);

  const dirPath = path.join(layerPath, projectId);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const layerLabel = {
    drafts: 'drafts 层',
    workspace: 'workspace 层',
    context: 'context 层'
  }[layer];

  const indexContent = generateDirectoryIndex({
    dirPath,
    dirName: `${projectId} (${layerLabel})`,
    purpose: `${projectId} 项目的 ${layerLabel} 材料`,
    rules: [
      '材料按主题组织，持久性内容追加更新',
      '时间性内容（会议记录）独立记录',
      '原始材料保留在 .source-materials/ 中'
    ]
  });

  const indexPath = path.join(dirPath, 'CLAUDE.md');
  fs.writeFileSync(indexPath, indexContent, 'utf-8');
}

/**
 * 更新根索引
 */
export function updateRootIndex(workspaceRoot: string): void {
  const indexContent = generateRootIndex(workspaceRoot);
  const indexPath = path.join(workspaceRoot, 'CLAUDE.md');
  fs.writeFileSync(indexPath, indexContent, 'utf-8');
}
