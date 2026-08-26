import type { MaterialInput } from "./context-types.js";
import type { ContentType } from "./file-naming.js";
import { RuleEngine } from "./rule-engine.js";
import * as path from "node:path";

/**
 * 内容分类器 - 使用规则引擎
 *
 * 重构说明：
 * - 业务规则已提取到 skills/material-ingest/references/classification-rules.md
 * - 本模块只负责调用规则引擎
 * - 用户修改规则文件即可调整分类行为
 */

export interface ClassificationResult {
  contentType: ContentType;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

// 全局规则引擎实例（懒加载）
let ruleEngineInstance: RuleEngine | null = null;

/**
 * 获取或创建规则引擎实例
 */
async function getRuleEngine(): Promise<RuleEngine> {
  if (!ruleEngineInstance) {
    // 规则文件路径
    const projectRoot = process.cwd();
    const rulesDir = path.join(projectRoot, 'skills', 'material-ingest', 'references');

    ruleEngineInstance = new RuleEngine(rulesDir);
    await ruleEngineInstance.loadRules();
  }

  return ruleEngineInstance;
}

/**
 * 分类内容类型（使用规则引擎）
 *
 * @param materials 材料列表
 * @param useAiAssist 是否使用 AI 辅助（未实现）
 * @returns 分类结果
 */
export async function classifyContent(
  materials: MaterialInput[],
  useAiAssist = false
): Promise<ClassificationResult> {
  const engine = await getRuleEngine();

  // 使用规则引擎执行分类
  const result = engine.executeClassification(materials);

  // 如果置信度低且启用了 AI 辅助，可以在这里调用 AI
  if (result.confidence === 'low' && useAiAssist) {
    // TODO: 实现 AI 辅助分类
    // const aiResult = await classifyWithAI(materials);
    // return aiResult;
  }

  return result;
}

/**
 * AI 辅助分类（预留接口）
 */
async function classifyWithAI(materials: MaterialInput[]): Promise<ClassificationResult> {
  // 预留：调用 AI API 进行分类
  // 例如：调用 OpenAI 或 Claude API

  throw new Error('AI 辅助分类未实现');
}

/**
 * 重置规则引擎（用于测试或重新加载规则）
 */
export function resetRuleEngine(): void {
  ruleEngineInstance = null;
}
