import type { ContentType } from "./file-naming.js";
import type { MaterialInput } from "./context-types.js";
import { RuleEngine } from "./rule-engine.js";
import * as path from "node:path";

/**
 * 模板系统 - 使用规则引擎
 *
 * 重构说明：
 * - 模板定义已提取到 skills/material-ingest/references/templates/
 * - 本模块只负责调用规则引擎获取模板
 * - 用户修改模板文件即可调整输出格式
 */

export type TemplateType =
  | 'meeting-notes'
  | 'user-feedback'
  | 'decision-record'
  | 'prd'
  | 'technical-spec'
  | 'seven-sections';

export interface TemplateConfig {
  type: TemplateType;
  title: string;
  sections: TemplateSection[];
}

export interface TemplateSection {
  heading: string;
  description?: string;
}

// 全局规则引擎实例（懒加载）
let ruleEngineInstance: RuleEngine | null = null;

/**
 * 获取或创建规则引擎实例
 */
async function getRuleEngine(): Promise<RuleEngine> {
  if (!ruleEngineInstance) {
    const projectRoot = process.cwd();
    const rulesDir = path.join(projectRoot, 'skills', 'material-ingest', 'references');

    ruleEngineInstance = new RuleEngine(rulesDir);
    await ruleEngineInstance.loadRules();
  }

  return ruleEngineInstance;
}

/**
 * 内容类型到模板类型的映射
 */
function contentTypeToTemplateType(contentType: ContentType): TemplateType {
  const mapping: Record<ContentType, TemplateType> = {
    'MEETING_NOTE': 'meeting-notes',
    'USER_FEEDBACK': 'user-feedback',
    'DECISION_RECORD': 'decision-record',
    'PRODUCT_REQUIREMENT': 'prd',
    'TECHNICAL_SPEC': 'technical-spec',
    'GENERAL': 'seven-sections',
    'PRODUCT_DOC': 'seven-sections',
    'DATA': 'seven-sections',
    'FACT': 'seven-sections',
    'OBSERVATION': 'seven-sections',
    'OPINION': 'seven-sections',
    'PROPOSAL': 'seven-sections',
    'CONFIRMED_DECISION': 'seven-sections',
    'OPEN_QUESTION': 'seven-sections',
    'DEPRECATED_CONTENT': 'seven-sections'
  };

  return mapping[contentType] || 'seven-sections';
}

/**
 * 根据内容类型选择模板（使用规则引擎）
 *
 * @param contentType 内容类型
 * @returns 模板配置
 */
export async function selectTemplate(contentType: ContentType): Promise<TemplateConfig> {
  const engine = await getRuleEngine();

  // 将内容类型映射到模板类型
  const templateType = contentTypeToTemplateType(contentType);

  // 从规则引擎获取模板
  const template = engine.getTemplate(templateType);

  if (!template) {
    // 如果找不到模板，返回默认的7章节模板
    const defaultTemplate = engine.getTemplate('seven-sections');
    if (defaultTemplate) {
      return {
        type: 'seven-sections',
        title: defaultTemplate.title,
        sections: defaultTemplate.sections
      };
    }

    // 如果连默认模板都没有，返回硬编码的备用模板
    return getFallbackTemplate();
  }

  return {
    type: templateType,
    title: template.title,
    sections: template.sections
  };
}

/**
 * 备用模板（当规则引擎无法加载时使用）
 */
function getFallbackTemplate(): TemplateConfig {
  return {
    type: 'seven-sections',
    title: '结构化材料整理稿',
    sections: [
      { heading: '背景与事实', description: '客观事实、历史背景、当前状态' },
      { heading: '用户反馈', description: '用户意见、问题、需求' },
      { heading: '观点与方案', description: '讨论的方案、建议、想法' },
      { heading: '已确认决策', description: '明确的决定和结论' },
      { heading: '行动项与分工', description: '待办事项、负责人、时间' },
      { heading: '风险与待确认', description: '风险点、未决问题' },
      { heading: '来源材料', description: '原始材料索引' }
    ]
  };
}

/**
 * 生成模板内容的框架（Markdown格式）
 */
export function generateTemplateMarkdown(
  template: TemplateConfig,
  taskGoal: string,
  materialCount: number,
  artifactRef: string
): string {
  const lines: string[] = [
    `# ${template.title}`,
    '',
    '> 本文件由项目 Runtime 生成。内容只对原始材料做结构化整理，不把用户反馈自动升级为产品需求，也不替代人工决策。',
    '',
    `- 任务目标：${taskGoal}`,
    `- 材料数量：${materialCount}`,
    `- 产物引用：${artifactRef}`,
    '',
  ];

  // 添加各个章节
  for (const section of template.sections) {
    lines.push(`## ${section.heading}`, '');
    if (section.description) {
      lines.push(`_${section.description}_`, '');
    }
    lines.push('- （待填充内容）', '');
  }

  // 添加原文保留说明
  lines.push(
    '## 原文保留说明',
    '',
    '原始材料已由 Runtime 登记到 `context-workspace/drafts/`，本整理稿不替换原文。',
    ''
  );

  return lines.join('\n');
}

/**
 * 预加载规则引擎（推荐在应用启动时调用）
 */
export async function preloadRuleEngine(): Promise<void> {
  await getRuleEngine();
}

/**
 * 重置规则引擎（用于测试或重新加载规则）
 */
export function resetRuleEngine(): void {
  ruleEngineInstance = null;
}

/**
 * 同步版本的模板选择（向后兼容，不推荐）
 */
export function selectTemplateSync(contentType: ContentType): TemplateConfig {
  // 如果规则引擎未加载，返回备用模板
  if (!ruleEngineInstance) {
    return getFallbackTemplate();
  }

  const templateType = contentTypeToTemplateType(contentType);
  const template = ruleEngineInstance.getTemplate(templateType);

  if (!template) {
    return getFallbackTemplate();
  }

  return {
    type: templateType,
    title: template.title,
    sections: template.sections
  };
}
