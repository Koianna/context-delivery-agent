import type { ContentType } from "./file-naming.js";
import type { MaterialInput } from "./context-types.js";

/**
 * 模板系统 - 根据内容类型选择合适的模板
 *
 * 参照 context-engineer 的 templates.md，提供多种模板
 * 同时保留7章节结构作为默认模板
 */

// MaterialSegment 的临时定义（避免循环依赖）
export interface MaterialSegment {
  content: string;
  index: number;
  material: MaterialInput;
}

export type TemplateType =
  | 'meeting-notes'       // 会议记录
  | 'user-feedback'       // 用户反馈
  | 'decision-record'     // 决策记录
  | 'prd'                 // 产品需求文档
  | 'technical-spec'      // 技术规格
  | 'seven-sections';     // 默认7章节（保留现有）

export interface TemplateConfig {
  type: TemplateType;
  title: string;
  sections: TemplateSection[];
}

export interface TemplateSection {
  heading: string;
  description?: string;
}

/**
 * 根据内容类型选择模板
 */
export function selectTemplate(contentType: ContentType): TemplateConfig {
  switch (contentType) {
    case 'MEETING_NOTE':
      return MEETING_NOTES_TEMPLATE;

    case 'USER_FEEDBACK':
      return USER_FEEDBACK_TEMPLATE;

    case 'DECISION_RECORD':
      return DECISION_RECORD_TEMPLATE;

    case 'PRODUCT_REQUIREMENT':
      return PRD_TEMPLATE;

    case 'TECHNICAL_SPEC':
      return TECHNICAL_SPEC_TEMPLATE;

    default:
      return SEVEN_SECTIONS_TEMPLATE;
  }
}

/**
 * 会议记录模板
 */
const MEETING_NOTES_TEMPLATE: TemplateConfig = {
  type: 'meeting-notes',
  title: '会议记录',
  sections: [
    { heading: '会议概要', description: '会议时间、参与人员、会议主题' },
    { heading: '关键讨论', description: '讨论的主要议题和观点' },
    { heading: '决策事项', description: '会议中达成的决策和结论' },
    { heading: '行动项', description: '待办事项、负责人、截止时间' },
    { heading: '未决问题', description: '需要后续确认或讨论的问题' },
    { heading: '补充说明', description: 'AI理解所需的背景信息' }
  ]
};

/**
 * 用户反馈模板
 */
const USER_FEEDBACK_TEMPLATE: TemplateConfig = {
  type: 'user-feedback',
  title: '用户反馈汇总',
  sections: [
    { heading: '反馈来源', description: '用户类型、渠道、时间范围' },
    { heading: '问题与痛点', description: '用户遇到的问题和困难' },
    { heading: '功能需求', description: '用户希望增加的功能' },
    { heading: '改进建议', description: '用户提出的改进意见' },
    { heading: '正面反馈', description: '用户认可的功能和体验' },
    { heading: '优先级评估', description: '反馈频次和影响范围' }
  ]
};

/**
 * 决策记录模板
 */
const DECISION_RECORD_TEMPLATE: TemplateConfig = {
  type: 'decision-record',
  title: '决策记录',
  sections: [
    { heading: '决策背景', description: '为什么需要这个决策' },
    { heading: '考虑的方案', description: '评估过的各种方案及优缺点' },
    { heading: '最终决策', description: '选择的方案和理由' },
    { heading: '影响范围', description: '这个决策的影响和后果' },
    { heading: '执行计划', description: '如何落地这个决策' },
    { heading: '后续跟进', description: '需要观察或调整的事项' }
  ]
};

/**
 * PRD 模板
 */
const PRD_TEMPLATE: TemplateConfig = {
  type: 'prd',
  title: '产品需求文档',
  sections: [
    { heading: '需求背景', description: '为什么做这个功能' },
    { heading: '目标用户', description: '功能面向的用户群体' },
    { heading: '核心功能', description: '功能的主要能力和交互' },
    { heading: '业务规则', description: '功能的约束条件和边界情况' },
    { heading: '成功指标', description: '如何衡量功能的成功' },
    { heading: '依赖与风险', description: '技术依赖和潜在风险' }
  ]
};

/**
 * 技术规格模板
 */
const TECHNICAL_SPEC_TEMPLATE: TemplateConfig = {
  type: 'technical-spec',
  title: '技术规格',
  sections: [
    { heading: '技术概述', description: '技术方案的整体说明' },
    { heading: '架构设计', description: '系统架构和组件关系' },
    { heading: '接口定义', description: 'API、数据结构、协议' },
    { heading: '技术选型', description: '使用的技术栈和理由' },
    { heading: '性能与安全', description: '性能要求和安全考虑' },
    { heading: '实施计划', description: '开发步骤和时间安排' }
  ]
};

/**
 * 默认7章节模板（保留现有逻辑）
 */
const SEVEN_SECTIONS_TEMPLATE: TemplateConfig = {
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
 * 将材料内容填充到模板中
 */
export function fillTemplate(
  template: TemplateConfig,
  segments: MaterialSegment[],
  classifyFn: (segment: MaterialSegment) => string
): Map<string, string[]> {
  const sectionContent = new Map<string, string[]>();

  // 初始化所有章节
  for (const section of template.sections) {
    sectionContent.set(section.heading, []);
  }

  // 分类并填充内容
  for (const segment of segments) {
    const targetSection = classifyFn(segment);

    // 映射到模板章节（如果找到对应的）
    const matchedSection = template.sections.find(s => s.heading === targetSection);
    if (matchedSection) {
      const content = sectionContent.get(matchedSection.heading) || [];
      content.push(segment.content);
      sectionContent.set(matchedSection.heading, content);
    } else {
      // 如果没有匹配的章节，放到第一个章节
      const firstSection = template.sections[0];
      const content = sectionContent.get(firstSection.heading) || [];
      content.push(segment.content);
      sectionContent.set(firstSection.heading, content);
    }
  }

  return sectionContent;
}
