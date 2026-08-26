import * as fs from "node:fs";
import * as path from "node:path";
import type { TargetLayer } from "./layer-router.js";
import { RuleEngine } from "./rule-engine.js";

/**
 * 语义匹配器 - 找到与新材料主题相关的现有文件
 *
 * 重构说明：
 * - 停用词已提取到 skills/material-ingest/references/stopwords.txt
 * - 使用规则引擎读取停用词
 * - 用户修改停用词文件即可调整匹配行为
 *
 * 策略：
 * 1. 基于文件名的字符串相似度（快速、无成本）
 * 2. 可扩展：未来可以集成 AI embedding
 */

export interface SemanticMatchResult {
  matchedFile: string | null;
  similarity: number;  // 0-1
  reason: string;
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
 * 语义匹配：找到与新材料主题相关的现有文件
 */
export async function findSemanticMatch(
  newTopic: string,
  projectId: string,
  targetLayer: TargetLayer,
  root: string,
  threshold: number = 0.7
): Promise<SemanticMatchResult> {

  const layerPath = targetLayer === 'workspace'
    ? path.join(root, 'context-workspace', 'workspace', 'projects')
    : path.join(root, 'context-workspace', targetLayer);

  const dir = path.join(layerPath, projectId);

  if (!fs.existsSync(dir)) {
    return { matchedFile: null, similarity: 0, reason: '目录不存在' };
  }

  const existingFiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'CLAUDE.md' && f !== 'README.md' && !f.startsWith('.'));

  if (existingFiles.length === 0) {
    return { matchedFile: null, similarity: 0, reason: '无现有文件' };
  }

  // 方法：基于文件名的字符串相似度
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const file of existingFiles) {
    const fileName = path.basename(file, '.md');

    // 移除日期前缀（如果是时间性内容）
    const cleanFileName = fileName.replace(/^\d{4}-\d{2}-\d{2}-?/, '');

    const score = await calculateStringSimilarity(newTopic, cleanFileName);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = file;
    }
  }

  // 相似度阈值判断
  if (bestScore >= threshold) {
    return {
      matchedFile: bestMatch,
      similarity: bestScore,
      reason: `文件名相似度 ${(bestScore * 100).toFixed(0)}%`
    };
  }

  return {
    matchedFile: null,
    similarity: bestScore,
    reason: `最高相似度 ${(bestScore * 100).toFixed(0)}%，低于阈值 ${(threshold * 100).toFixed(0)}%`
  };
}

/**
 * 计算字符串相似度（Jaccard 相似度）
 *
 * 原理：
 * - 将字符串分词（按空格、连字符分割）
 * - 计算两个词集合的交集和并集
 * - 相似度 = 交集大小 / 并集大小
 */
async function calculateStringSimilarity(str1: string, str2: string): Promise<number> {
  // 分词：转小写，按空格、连字符、下划线分割
  const tokens1 = await tokenize(str1);
  const tokens2 = await tokenize(str2);

  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  // 计算交集
  const intersection = new Set([...set1].filter(x => set2.has(x)));

  // 计算并集
  const union = new Set([...set1, ...set2]);

  if (union.size === 0) {
    return 0;
  }

  // Jaccard 相似度
  return intersection.size / union.size;
}

/**
 * 分词：将字符串拆分为词语（使用规则引擎的停用词）
 */
async function tokenize(str: string): Promise<string[]> {
  const engine = await getRuleEngine();
  const stopwords = engine.getStopwords();

  return str
    .toLowerCase()
    .replace(/[，。！？；、]/g, ' ')  // 中文标点替换为空格
    .split(/[\s\-_]+/)  // 按空格、连字符、下划线分割
    .filter(token => token.length > 0)  // 过滤空字符串
    .filter(token => !stopwords.has(token));  // 使用规则引擎的停用词
}

/**
 * 计算编辑距离（Levenshtein 距离）- 备用方法
 *
 * 当需要更精确的字符级相似度时使用
 */
export function calculateEditDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // 创建 DP 表
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // 初始化
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // 填充 DP 表
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,    // 删除
          dp[i][j - 1] + 1,    // 插入
          dp[i - 1][j - 1] + 1 // 替换
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * 基于编辑距离的相似度（0-1）
 */
export function calculateEditSimilarity(str1: string, str2: string): number {
  const distance = calculateEditDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLen = Math.max(str1.length, str2.length);

  if (maxLen === 0) return 1;

  return 1 - (distance / maxLen);
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
