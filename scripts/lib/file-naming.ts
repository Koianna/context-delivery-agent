import * as fs from "node:fs";
import * as path from "node:path";
import type { MaterialInput } from "./context-types.js";
import { findSemanticMatch } from "./semantic-matcher.js";
import type { TargetLayer } from "./layer-router.js";

/**
 * 文件命名工具 - 参照 context-engineer 原则
 *
 * 核心规则：
 * - 时间性内容（会议记录）：{date}-{topic}.md
 * - 持久性内容（需求整理）：{topic}.md
 * - 用户友好：可读的文件名，而非 task_id
 */

export interface FileNamingResult {
  fileName: string;
  isTemporal: boolean;
  contentType: ContentType;
}

export interface FileDecision {
  action: 'create' | 'append' | 'confirm';
  targetPath: string;
  existingPath?: string;
  reason: string;
}

export type ContentType =
  | 'MEETING_NOTE'
  | 'USER_FEEDBACK'
  | 'PRODUCT_REQUIREMENT'
  | 'DECISION_RECORD'
  | 'PRODUCT_DOC'
  | 'TECHNICAL_SPEC'
  | 'GENERAL';

/**
 * 生成用户可读的文件名
 */
export function generateReadableFileName(
  materials: MaterialInput[],
  taskGoal: string,
  projectId: string,
  scopeTopic?: string
): FileNamingResult {
  const contentType = classifyContentType(materials);
  const isTemporal = ['MEETING_NOTE', 'DECISION_RECORD'].includes(contentType);

  if (isTemporal) {
    // 时间性内容：{date}-{topic}.md
    const date = extractDate(materials);
    const topic = extractTopic(materials, taskGoal, projectId, scopeTopic);
    const sanitized = sanitizeFileName(topic);

    const prefix = contentType === 'DECISION_RECORD' ? '决策-' : '';
    return {
      fileName: `${date}-${prefix}${sanitized}.md`,
      isTemporal: true,
      contentType
    };
  }

  // 持久性内容：{topic}.md
  const topic = extractTopic(materials, taskGoal, projectId, scopeTopic);

  const typeMap: Record<ContentType, string> = {
    'USER_FEEDBACK': '用户反馈汇总',
    'PRODUCT_REQUIREMENT': '需求整理',
    'PRODUCT_DOC': '产品文档',
    'TECHNICAL_SPEC': '技术规格',
    'GENERAL': sanitizeFileName(topic),
    'MEETING_NOTE': '',
    'DECISION_RECORD': '',
  };

  return {
    fileName: typeMap[contentType] + '.md',
    isTemporal: false,
    contentType
  };
}

/**
 * 分类内容类型
 */
export function classifyContentType(materials: MaterialInput[]): ContentType {
  const allTypes = materials.map(m => m.source_type?.toUpperCase() || '');
  const allNames = materials.map(m => m.name?.toLowerCase() || '');
  const combined = [...allTypes, ...allNames].join(' ');

  if (/MEETING|会议|纪要|kick.*off|讨论会/i.test(combined)) {
    return 'MEETING_NOTE';
  }

  if (/USER_FEEDBACK|用户反馈|反馈汇总|客服反馈/i.test(combined)) {
    return 'USER_FEEDBACK';
  }

  if (/PRODUCT_REQUIREMENT|PRD|需求文档|产品需求/i.test(combined)) {
    return 'PRODUCT_REQUIREMENT';
  }

  if (/DECISION|决策|会议决定|讨论结论/i.test(combined)) {
    return 'DECISION_RECORD';
  }

  if (/PRODUCT_DOC|产品文档|功能说明/i.test(combined)) {
    return 'PRODUCT_DOC';
  }

  if (/TECHNICAL|技术规格|架构设计/i.test(combined)) {
    return 'TECHNICAL_SPEC';
  }

  return 'GENERAL';
}

/**
 * 从材料中提取日期
 */
export function extractDate(materials: MaterialInput[]): string {
  // 1. 从 source_time 提取（最可靠）
  for (const material of materials) {
    if (material.source_time) {
      const match = material.source_time.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) return match[1];
    }
  }

  // 2. 从 material.name 中提取日期模式
  for (const material of materials) {
    const name = material.name || '';

    // 模式 1: 2026-08-20
    const iso = name.match(/(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];

    // 模式 2: 2026年8月20日
    const chinese = name.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (chinese) {
      const [, year, month, day] = chinese;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // 模式 3: 08/20/2026
    const slash = name.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slash) {
      const [, month, day, year] = slash;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  // 3. 使用当前日期
  return new Date().toISOString().split('T')[0];
}

/**
 * 从材料中提取主题
 */
export function extractTopic(
  materials: MaterialInput[],
  taskGoal: string,
  projectId: string,
  scopeTopic?: string
): string {
  // 1. 从 task_goal 提取（最准确）
  if (taskGoal && taskGoal !== '整理项目材料') {
    const cleaned = cleanTopicFromGoal(taskGoal);
    if (cleaned) return cleaned;
  }

  // 2. 从 analysis_scope.topic 提取
  if (scopeTopic && scopeTopic !== projectId) {
    return scopeTopic;
  }

  // 3. 从第一个材料的名称提取
  if (materials.length > 0) {
    const firstMaterial = materials[0];
    const cleaned = cleanMaterialName(firstMaterial.name);
    if (cleaned && cleaned.length > 2) return cleaned;
  }

  // 4. 从 project_id 推断
  return inferTopicFromProjectId(projectId);
}

function cleanTopicFromGoal(goal: string): string {
  return goal
    // 1. 移除开头的口语词和引导词
    .replace(/^(这是|这个是|这次是|这里是|有个|有一个)\s*/g, '')
    // 2. 移除开头的动词前缀+一下（例如"记录一下"、"整理一下"）
    .replace(/^(整理|分析|归纳|维护|更新|记录|讨论|查看|处理|管理)一下\s*/g, '')
    // 3. 移除单独的开头动词前缀
    .replace(/^(整理|分析|归纳|维护|更新|记录|讨论|查看|处理|管理)\s*/g, '')
    // 4. 移除结尾的动作词
    .replace(/[，,]\s*(整理一下|分析一下|看一下|记录一下|处理一下|一下)$/g, '')
    .replace(/(整理一下|分析一下|看一下|记录一下|处理一下|一下)$/g, '')
    // 5. 移除"的XX"这种冗余结构（保留核心主题）
    .replace(/的(范围|内容|材料|文档|信息|说明|介绍)$/g, '')
    // 6. 移除结尾的"范围"、"内容"等
    .replace(/(范围|内容|信息)$/g, '')
    // 7. 移除结尾的"的"
    .replace(/的$/g, '')
    // 8. 移除"材料"后缀
    .replace(/材料$/g, '')
    // 9. 清理多余空格
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMaterialName(name: string): string {
  return name
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/g, '')
    .replace(/[-_]?\d{4}-\d{2}-\d{2}$/g, '')
    .replace(/^(\d+)[-.)、]?\s*/g, '')
    .replace(/\.(md|txt|markdown)$/i, '')
    .trim();
}

function inferTopicFromProjectId(projectId: string): string {
  const map: Record<string, string> = {
    'knowledge-qa-assistant': '知识库问答助手',
    'prd-review-agent': 'PRD审核助手',
  };
  return map[projectId] || projectId.replace(/-/g, ' ');
}

/**
 * 清理文件名中的非法字符
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[，。！？；、]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * 决定文件操作（创建 vs 追加）
 *
 * 增强版：支持语义匹配
 */
export async function decideFileAction(
  fileName: string,
  projectId: string,
  isTemporal: boolean,
  targetLayer: TargetLayer,
  root: string,
  options?: {
    topic?: string;                    // 新增：主题（用于语义匹配）
    enableSemanticMatch?: boolean;     // 新增：启用语义匹配
    semanticThreshold?: number;        // 新增：语义相似度阈值
    appendThresholdDays?: number;      // 新增：追加阈值天数
  }
): Promise<FileDecision> {
  const {
    topic = '',
    enableSemanticMatch = false,
    semanticThreshold = 0.7,
    appendThresholdDays = 7
  } = options || {};

  const basePath = path.join(
    root,
    'context-workspace',
    targetLayer,
    targetLayer === 'workspace' ? `projects/${projectId}` : projectId
  );

  const targetPath = path.join(basePath, fileName);

  // 1. 精确文件名匹配
  if (fs.existsSync(targetPath)) {
    // 时间性内容 → 创建新文件
    if (isTemporal) {
      const uniquePath = makeUniqueFileName(targetPath);
      return {
        action: 'create',
        targetPath: uniquePath,
        reason: '时间性内容，每次独立记录'
      };
    }

    // 持久性内容 → 检查时间间隔
    const stats = fs.statSync(targetPath);
    const daysSince = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);

    if (daysSince < appendThresholdDays) {
      return {
        action: 'append',
        targetPath,
        existingPath: targetPath,
        reason: `精确匹配，${Math.round(daysSince)} 天内更新过，追加新内容`
      };
    }

    // 超过阈值 → 创建新文件
    return {
      action: 'create',
      targetPath,
      reason: `距上次更新已 ${Math.round(daysSince)} 天，创建新版本`
    };
  }

  // 2. 语义匹配（新增功能）
  if (enableSemanticMatch && topic && !isTemporal) {
    const semanticMatch = await findSemanticMatch(
      topic,
      projectId,
      targetLayer,
      root,
      semanticThreshold
    );

    if (semanticMatch.matchedFile) {
      const matchedPath = path.join(basePath, semanticMatch.matchedFile);

      // 检查匹配文件的时间间隔
      if (fs.existsSync(matchedPath)) {
        const stats = fs.statSync(matchedPath);
        const daysSince = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);

        if (daysSince < appendThresholdDays) {
          return {
            action: 'append',
            targetPath: matchedPath,
            existingPath: matchedPath,
            reason: `语义匹配到 ${semanticMatch.matchedFile}（相似度 ${(semanticMatch.similarity * 100).toFixed(0)}%），${Math.round(daysSince)} 天内更新过`
          };
        }
      }
    }
  }

  // 3. 无匹配 → 创建新文件
  return {
    action: 'create',
    targetPath,
    reason: '首次创建此主题的文件'
  };
}

/**
 * 同步版本（向后兼容，不支持语义匹配）
 */
export function decideFileActionSync(
  fileName: string,
  projectId: string,
  isTemporal: boolean,
  targetLayer: TargetLayer,
  root: string
): FileDecision {
  const basePath = path.join(
    root,
    'context-workspace',
    targetLayer,
    targetLayer === 'workspace' ? `projects/${projectId}` : projectId
  );

  const targetPath = path.join(basePath, fileName);

  // 1. 文件不存在 → 创建
  if (!fs.existsSync(targetPath)) {
    return {
      action: 'create',
      targetPath,
      reason: '首次创建此主题的文件'
    };
  }

  // 2. 时间性内容 → 永远创建新文件
  if (isTemporal) {
    const uniquePath = makeUniqueFileName(targetPath);
    return {
      action: 'create',
      targetPath: uniquePath,
      reason: '时间性内容，每次独立记录'
    };
  }

  // 3. 持久性内容 → 检查时间间隔
  const stats = fs.statSync(targetPath);
  const daysSince = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);

  if (daysSince < 7) {
    return {
      action: 'append',
      targetPath,
      existingPath: targetPath,
      reason: `最近 ${Math.round(daysSince)} 天内更新过，追加新内容`
    };
  }

  // 4. 超过 7 天 → 创建新文件
  return {
    action: 'create',
    targetPath,
    reason: `距上次更新已 ${Math.round(daysSince)} 天，创建新版本`
  };
}

/**
 * 生成唯一文件名（处理冲突）
 */
export function makeUniqueFileName(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  let counter = 2;
  let uniquePath = filePath;

  while (fs.existsSync(uniquePath)) {
    uniquePath = path.join(dir, `${base}-${counter}${ext}`);
    counter++;
  }

  return uniquePath;
}
