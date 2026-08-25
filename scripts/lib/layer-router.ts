import type { MaterialInput } from "./context-types.js";
import type { ClassificationResult } from "./content-classifier.js";

/**
 * 层级路由器 - 智能判断材料应该放在哪一层
 *
 * 三层模型：
 * - drafts: 原始材料、初步想法（低可信度）
 * - workspace: 正在进行的工作（中可信度）
 * - context: 已确认的知识（高可信度）
 *
 * 原则：When in doubt, drafts
 */

export type TargetLayer = 'drafts' | 'workspace' | 'context';

export interface RoutingDecision {
  layer: TargetLayer;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  requiresConfirmation: boolean;
}

/**
 * 智能路由：分析材料可信度，决定目标层级
 */
export function routeToLayer(
  materials: MaterialInput[],
  classificationResult: ClassificationResult,
  taskGoal: string,
  enableSmartRouting: boolean = false
): RoutingDecision {

  // 如果未启用智能路由，默认全部到 drafts
  if (!enableSmartRouting) {
    return {
      layer: 'drafts',
      confidence: 'high',
      reason: '智能路由未启用，使用默认策略',
      requiresConfirmation: false
    };
  }

  // === 规则 1：明确标记为"已确认"的 → context ===
  if (hasConfirmedTag(materials, taskGoal)) {
    return {
      layer: 'context',
      confidence: 'high',
      reason: '材料明确标记为已确认的知识',
      requiresConfirmation: true  // 高风险，需要确认
    };
  }

  // === 规则 2：有明确所有者和时间线的任务 → workspace ===
  if (hasOwnerAndTimeline(taskGoal, materials)) {
    return {
      layer: 'workspace',
      confidence: 'medium',
      reason: '有明确所有者和时间线的工作任务',
      requiresConfirmation: false
    };
  }

  // === 规则 3：PRD 或产品需求 → workspace ===
  if (classificationResult.contentType === 'PRODUCT_REQUIREMENT') {
    // 检查是否处于活跃状态
    if (hasActiveStatus(taskGoal, materials)) {
      return {
        layer: 'workspace',
        confidence: 'medium',
        reason: 'PRD 或产品需求，且处于活跃状态',
        requiresConfirmation: false
      };
    }
  }

  // === 规则 4：会议记录、初步想法 → drafts ===
  if (classificationResult.contentType === 'MEETING_NOTE') {
    return {
      layer: 'drafts',
      confidence: 'high',
      reason: '会议记录属于原始材料',
      requiresConfirmation: false
    };
  }

  // === 规则 5：用户反馈、未确认内容 → drafts ===
  if (classificationResult.contentType === 'USER_FEEDBACK') {
    return {
      layer: 'drafts',
      confidence: 'high',
      reason: '用户反馈需要验证后提升',
      requiresConfirmation: false
    };
  }

  // === 规则 6：决策记录 → drafts（需人工确认后提升）===
  if (classificationResult.contentType === 'DECISION_RECORD') {
    return {
      layer: 'drafts',
      confidence: 'medium',
      reason: '决策记录待确认后可提升到 workspace',
      requiresConfirmation: false
    };
  }

  // === 默认：When in doubt, drafts ===
  return {
    layer: 'drafts',
    confidence: 'medium',
    reason: '不确定时默认放 drafts（安全策略）',
    requiresConfirmation: false
  };
}

/**
 * 检查材料是否明确标记为"已确认"
 */
function hasConfirmedTag(materials: MaterialInput[], taskGoal: string): boolean {
  const combined = [
    taskGoal,
    ...materials.map(m => m.source_type || ''),
    ...materials.map(m => m.name || '')
  ].join(' ');

  return /已确认|confirmed|verified|approved|稳定知识/i.test(combined);
}

/**
 * 检查是否有明确的所有者和时间线
 */
function hasOwnerAndTimeline(taskGoal: string, materials: MaterialInput[]): boolean {
  const combined = [
    taskGoal,
    ...materials.map(m => m.name || ''),
    ...materials.map(m => m.source_owner || '')
  ].join(' ');

  // 检查所有者
  const hasOwner =
    /负责人[:：]\s*\S+|owner[:：]\s*\S+|@\w+负责|\w+负责/i.test(combined) ||
    materials.some(m => m.source_owner && m.source_owner.trim().length > 0);

  // 检查时间线
  const hasTimeline = /截止[:：]|deadline[:：]|Q\d|本季度|下月|本周|下周|\d{4}-\d{2}-\d{2}/i.test(combined);

  return hasOwner || hasTimeline;
}

/**
 * 检查是否处于活跃状态
 */
function hasActiveStatus(taskGoal: string, materials: MaterialInput[]): boolean {
  const combined = [
    taskGoal,
    ...materials.map(m => m.name || '')
  ].join(' ');

  // 活跃状态关键词
  return /进行中|开发中|设计中|待开发|in.*progress|wip|active/i.test(combined);
}
