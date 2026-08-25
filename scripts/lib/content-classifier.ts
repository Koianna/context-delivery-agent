import type { MaterialInput } from "./context-types.js";
import type { ContentType } from "./file-naming.js";

/**
 * 内容分类器 - 混合模式（规则优先 + AI辅助）
 *
 * 策略：
 * 1. 先用规则匹配（快速、确定）
 * 2. 如果置信度低且启用AI，则调用AI辅助
 * 3. 保留规则匹配的优势，AI只在必要时介入
 */

export interface ClassificationResult {
  contentType: ContentType;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  aiAssisted?: boolean;
}

/**
 * 两阶段分类：规则匹配 → AI辅助（可选）
 */
export async function classifyContent(
  materials: MaterialInput[],
  useAI: boolean = false
): Promise<ClassificationResult> {

  // 阶段 1：规则匹配（保留现有逻辑）
  const ruleBasedResult = classifyByRules(materials);

  // 如果高置信度，直接返回
  if (ruleBasedResult.confidence === 'high') {
    return ruleBasedResult;
  }

  // 阶段 2：置信度低且启用AI → AI辅助判断
  if (useAI && ruleBasedResult.confidence === 'low') {
    // TODO: 在后续实现中集成AI调用
    // return await classifyByAI(materials, ruleBasedResult);

    // 当前返回规则结果
    return {
      ...ruleBasedResult,
      reason: ruleBasedResult.reason + '（AI辅助未启用）'
    };
  }

  return ruleBasedResult;
}

/**
 * 基于规则的分类（确定性）
 */
function classifyByRules(materials: MaterialInput[]): ClassificationResult {
  const allTypes = materials.map(m => m.source_type?.toUpperCase() || '');
  const allNames = materials.map(m => m.name?.toLowerCase() || '');
  const combined = [...allTypes, ...allNames].join(' ');

  // === 高置信度规则（明确标记） ===

  // 规则 1：source_type 明确标记为会议
  if (allTypes.some(t => /^(MEETING|MEETING_NOTE)$/i.test(t))) {
    return {
      contentType: 'MEETING_NOTE',
      confidence: 'high',
      reason: 'source_type 明确标记为会议'
    };
  }

  // 规则 2：source_type 明确标记为用户反馈
  if (allTypes.some(t => /^(USER_FEEDBACK|FEEDBACK)$/i.test(t))) {
    return {
      contentType: 'USER_FEEDBACK',
      confidence: 'high',
      reason: 'source_type 明确标记为用户反馈'
    };
  }

  // 规则 3：source_type 明确标记为产品需求
  if (allTypes.some(t => /^(PRODUCT_REQUIREMENT|PRD|REQUIREMENT)$/i.test(t))) {
    return {
      contentType: 'PRODUCT_REQUIREMENT',
      confidence: 'high',
      reason: 'source_type 明确标记为产品需求'
    };
  }

  // 规则 4：source_type 明确标记为决策记录
  if (allTypes.some(t => /^(DECISION_RECORD|DECISION)$/i.test(t))) {
    return {
      contentType: 'DECISION_RECORD',
      confidence: 'high',
      reason: 'source_type 明确标记为决策记录'
    };
  }

  // === 中等置信度规则（关键词匹配） ===

  // 规则 5：文件名包含会议相关关键词
  if (/会议|meeting|纪要|kick.*off|讨论会|站会|周会|月会/i.test(combined)) {
    return {
      contentType: 'MEETING_NOTE',
      confidence: 'medium',
      reason: '内容包含会议相关关键词'
    };
  }

  // 规则 6：文件名包含反馈相关关键词
  if (/用户反馈|客户反馈|反馈汇总|客服反馈|bug.*report|feedback/i.test(combined)) {
    return {
      contentType: 'USER_FEEDBACK',
      confidence: 'medium',
      reason: '内容包含反馈相关关键词'
    };
  }

  // 规则 7：文件名包含需求相关关键词
  if (/产品需求|需求文档|prd|requirement|功能.*需求|需求.*整理/i.test(combined)) {
    return {
      contentType: 'PRODUCT_REQUIREMENT',
      confidence: 'medium',
      reason: '内容包含需求相关关键词'
    };
  }

  // 规则 8：文件名包含决策相关关键词
  if (/决策|决定|讨论.*结论|decision.*record|adr/i.test(combined)) {
    return {
      contentType: 'DECISION_RECORD',
      confidence: 'medium',
      reason: '内容包含决策相关关键词'
    };
  }

  // 规则 9：文件名包含产品文档关键词
  if (/产品文档|功能.*说明|产品.*介绍|product.*doc/i.test(combined)) {
    return {
      contentType: 'PRODUCT_DOC',
      confidence: 'medium',
      reason: '内容包含产品文档关键词'
    };
  }

  // 规则 10：文件名包含技术规格关键词
  if (/技术.*规格|技术.*文档|架构.*设计|technical.*spec|api.*doc/i.test(combined)) {
    return {
      contentType: 'TECHNICAL_SPEC',
      confidence: 'medium',
      reason: '内容包含技术规格关键词'
    };
  }

  // === 低置信度（无法判断） ===

  return {
    contentType: 'GENERAL',
    confidence: 'low',
    reason: '无明确特征，建议AI辅助判断或人工确认'
  };
}

/**
 * 基于AI的分类（未来实现）
 */
// async function classifyByAI(
//   materials: MaterialInput[],
//   ruleResult: ClassificationResult
// ): Promise<ClassificationResult> {
//   // TODO: 调用 AI 模型分析
//   // 1. 构建提示词，包含材料名称、类型、部分内容
//   // 2. 调用 AI 模型
//   // 3. 解析返回结果
//
//   return {
//     contentType: 'GENERAL',
//     confidence: 'medium',
//     reason: 'AI辅助判断',
//     aiAssisted: true
//   };
// }
