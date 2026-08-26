import type { MaterialInput } from "./context-types.js";
import type { ClassificationResult } from "./content-classifier.js";
import { RuleEngine } from "./rule-engine.js";
import * as path from "node:path";

/**
 * 层级路由器 - 使用规则引擎
 *
 * 重构说明：
 * - 业务规则已提取到 skills/material-ingest/references/routing-rules.md
 * - 本模块只负责调用规则引擎
 * - 用户修改规则文件即可调整路由行为
 */

export type TargetLayer = 'drafts' | 'workspace' | 'context';

export interface RoutingDecision {
  layer: TargetLayer;
  confidence: 'high' | 'medium';
  reason: string;
  requiresConfirmation: boolean;
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
 * 路由到目标层级（使用规则引擎）
 *
 * @param materials 材料列表
 * @param classification 分类结果
 * @param taskGoal 任务目标
 * @param enableSmartRouting 是否启用智能路由
 * @returns 路由决策
 */
export function routeToLayer(
  materials: MaterialInput[],
  classification: ClassificationResult,
  taskGoal: string,
  enableSmartRouting = false
): RoutingDecision {
  // 如果未启用智能路由，固定到 drafts
  if (!enableSmartRouting) {
    return {
      layer: 'drafts',
      confidence: 'high',
      reason: '智能路由未启用，使用默认策略',
      requiresConfirmation: false
    };
  }

  // 使用规则引擎执行路由（同步版本）
  return routeToLayerSync(materials, classification, taskGoal);
}

/**
 * 同步版本的路由（用于向后兼容）
 */
function routeToLayerSync(
  materials: MaterialInput[],
  classification: ClassificationResult,
  taskGoal: string
): RoutingDecision {
  // 注意：这里无法使用 async/await，所以需要确保规则引擎已经加载
  // 在实际使用中，应该在应用启动时预加载规则引擎

  if (!ruleEngineInstance) {
    // 如果规则引擎未加载，使用默认策略
    return {
      layer: 'drafts',
      confidence: 'medium',
      reason: '规则引擎未加载，使用默认策略',
      requiresConfirmation: false
    };
  }

  // 使用规则引擎执行路由
  return ruleEngineInstance.executeRouting(materials, classification.contentType, taskGoal);
}

/**
 * 异步版本的路由（推荐使用）
 */
export async function routeToLayerAsync(
  materials: MaterialInput[],
  classification: ClassificationResult,
  taskGoal: string,
  enableSmartRouting = false
): Promise<RoutingDecision> {
  // 如果未启用智能路由，固定到 drafts
  if (!enableSmartRouting) {
    return {
      layer: 'drafts',
      confidence: 'high',
      reason: '智能路由未启用，使用默认策略',
      requiresConfirmation: false
    };
  }

  const engine = await getRuleEngine();

  // 使用规则引擎执行路由
  return engine.executeRouting(materials, classification.contentType, taskGoal);
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
