import * as fs from "node:fs";
import * as path from "node:path";
import type { MaterialInput } from "./context-types.js";
import type { ContentType } from "./file-naming.js";

/**
 * 规则引擎 - 读取和执行规则文件
 *
 * 设计原则：
 * - 业务规则在 Skill 文件中定义（Markdown）
 * - 代码只负责读取和执行规则
 * - 用户修改规则文件即可调整行为
 */

// ==================== 类型定义 ====================

export interface ClassificationRule {
  type: ContentType;
  priority: number;
  sourceTypeMatches?: string[];  // 精确匹配
  keywords: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface RoutingRule {
  name: string;
  priority: number;
  layer: 'drafts' | 'workspace' | 'context';
  conditions: string[];
  requiresConfirmation: boolean;
  reason: string;
}

export interface TemplateDefinition {
  type: string;
  title: string;
  sections: Array<{
    heading: string;
    description?: string;
  }>;
}

// ==================== 规则引擎 ====================

export class RuleEngine {
  private classificationRules: ClassificationRule[] = [];
  private routingRules: RoutingRule[] = [];
  private templates: Map<string, TemplateDefinition> = new Map();
  private stopwords: Set<string> = new Set();
  private rulesDir: string;

  constructor(rulesDir: string) {
    this.rulesDir = rulesDir;
  }

  /**
   * 加载所有规则文件
   */
  async loadRules(): Promise<void> {
    await this.loadClassificationRules();
    await this.loadRoutingRules();
    await this.loadTemplates();
    await this.loadStopwords();
  }

  /**
   * 加载分类规则
   */
  private async loadClassificationRules(): Promise<void> {
    const rulesPath = path.join(this.rulesDir, 'classification-rules.md');

    if (!fs.existsSync(rulesPath)) {
      console.warn(`Classification rules not found: ${rulesPath}`);
      return;
    }

    const content = fs.readFileSync(rulesPath, 'utf-8');

    // 解析规则
    this.classificationRules = this.parseClassificationRules(content);
  }

  /**
   * 解析分类规则（从 Markdown）
   */
  private parseClassificationRules(content: string): ClassificationRule[] {
    const rules: ClassificationRule[] = [];
    const lines = content.split('\n');

    let currentRule: Partial<ClassificationRule> | null = null;
    let inKeywords = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 检测规则标题：### N. TYPE_NAME（描述）
      const titleMatch = trimmed.match(/^###\s+(\d+)\.\s+(\w+)（/);
      if (titleMatch) {
        // 保存上一个规则
        if (currentRule && currentRule.type) {
          rules.push(currentRule as ClassificationRule);
        }

        // 开始新规则
        currentRule = {
          type: titleMatch[2] as ContentType,
          priority: parseInt(titleMatch[1]),
          sourceTypeMatches: [],
          keywords: [],
          confidence: 'medium'
        };
        inKeywords = false;
        continue;
      }

      if (!currentRule) continue;

      // 解析触发条件（source_type）
      if (trimmed.startsWith('- source_type 精确匹配:')) {
        const matches = trimmed.match(/`([^`]+)`/g);
        if (matches) {
          currentRule.sourceTypeMatches = matches.map(m => m.replace(/`/g, ''));
        }
      }

      // 解析关键词
      if (trimmed.startsWith('**关键词**：')) {
        inKeywords = true;
        continue;
      }

      if (inKeywords && trimmed.startsWith('- ')) {
        const keywords = trimmed.substring(2).split(/[,，]/).map(k => k.trim()).filter(k => k);
        currentRule.keywords = currentRule.keywords || [];
        currentRule.keywords.push(...keywords);
      }

      // 解析置信度
      if (trimmed.startsWith('**置信度**:')) {
        const conf = trimmed.match(/(high|medium|low)/);
        if (conf) {
          currentRule.confidence = conf[1] as 'high' | 'medium' | 'low';
        }
        inKeywords = false;
      }
    }

    // 保存最后一个规则
    if (currentRule && currentRule.type) {
      rules.push(currentRule as ClassificationRule);
    }

    // 按优先级排序
    return rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 加载路由规则
   */
  private async loadRoutingRules(): Promise<void> {
    const rulesPath = path.join(this.rulesDir, 'routing-rules.md');

    if (!fs.existsSync(rulesPath)) {
      console.warn(`Routing rules not found: ${rulesPath}`);
      return;
    }

    const content = fs.readFileSync(rulesPath, 'utf-8');

    // 解析规则
    this.routingRules = this.parseRoutingRules(content);
  }

  /**
   * 解析路由规则（从 Markdown）
   */
  private parseRoutingRules(content: string): RoutingRule[] {
    const rules: RoutingRule[] = [];
    const lines = content.split('\n');

    let currentRule: Partial<RoutingRule> | null = null;
    let inConditions = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 检测规则标题：### 规则 N：描述 → 层级
      const titleMatch = trimmed.match(/^###\s+规则\s+(\d+)：(.+?)\s+→\s+(\w+)/);
      if (titleMatch) {
        // 保存上一个规则
        if (currentRule && currentRule.name) {
          rules.push(currentRule as RoutingRule);
        }

        // 开始新规则
        currentRule = {
          name: titleMatch[2],
          priority: parseInt(titleMatch[1]),
          layer: titleMatch[3] as 'drafts' | 'workspace' | 'context',
          conditions: [],
          requiresConfirmation: false,
          reason: ''
        };
        inConditions = false;
        continue;
      }

      if (!currentRule) continue;

      // 解析目标层级
      if (trimmed.startsWith('**目标层级**:')) {
        const layerMatch = trimmed.match(/:\s*(\w+)/);
        if (layerMatch) {
          currentRule.layer = layerMatch[1] as 'drafts' | 'workspace' | 'context';
        }
      }

      // 解析需要确认
      if (trimmed.startsWith('**需要确认**:')) {
        currentRule.requiresConfirmation = trimmed.includes('true');
      }

      // 解析触发条件
      if (trimmed.startsWith('**触发条件**')) {
        inConditions = true;
        continue;
      }

      if (inConditions && trimmed.startsWith('- ')) {
        currentRule.conditions = currentRule.conditions || [];
        currentRule.conditions.push(trimmed.substring(2));
      }

      // 解析理由
      if (trimmed.startsWith('**理由**:')) {
        currentRule.reason = trimmed.substring('**理由**:'.length).trim();
        inConditions = false;
      }
    }

    // 保存最后一个规则
    if (currentRule && currentRule.name) {
      rules.push(currentRule as RoutingRule);
    }

    // 按优先级排序
    return rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 加载模板
   */
  private async loadTemplates(): Promise<void> {
    const templatesDir = path.join(this.rulesDir, 'templates');

    if (!fs.existsSync(templatesDir)) {
      console.warn(`Templates directory not found: ${templatesDir}`);
      return;
    }

    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.md') && f !== 'README.md');

    for (const file of files) {
      const filePath = path.join(templatesDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const template = this.parseTemplate(content);

      if (template) {
        this.templates.set(template.type, template);
      }
    }
  }

  /**
   * 解析模板（从 Markdown）
   */
  private parseTemplate(content: string): TemplateDefinition | null {
    const lines = content.split('\n');

    let title = '';
    let type = '';
    const sections: Array<{ heading: string; description?: string }> = [];

    let currentSection: { heading: string; description?: string } | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // 解析标题
      if (trimmed.startsWith('# ') && !title) {
        title = trimmed.substring(2);
      }

      // 解析模板类型
      if (trimmed.startsWith('> 模板类型:')) {
        type = trimmed.split(':')[1].trim();
      }

      // 解析章节标题
      if (trimmed.startsWith('## ') && trimmed !== '## 章节') {
        // 保存上一个章节
        if (currentSection) {
          sections.push(currentSection);
        }

        currentSection = {
          heading: trimmed.substring(3),
          description: undefined
        };
      }

      // 解析章节说明（第一行非空内容）
      if (currentSection && !currentSection.description && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('>') && !trimmed.startsWith('---')) {
        currentSection.description = trimmed;
      }

      // 章节分隔符
      if (trimmed === '---' && currentSection) {
        sections.push(currentSection);
        currentSection = null;
      }
    }

    // 保存最后一个章节
    if (currentSection) {
      sections.push(currentSection);
    }

    if (!type || !title || sections.length === 0) {
      return null;
    }

    return { type, title, sections };
  }

  /**
   * 加载停用词
   */
  private async loadStopwords(): Promise<void> {
    const stopwordsPath = path.join(this.rulesDir, 'stopwords.txt');

    if (!fs.existsSync(stopwordsPath)) {
      console.warn(`Stopwords file not found: ${stopwordsPath}`);
      return;
    }

    const content = fs.readFileSync(stopwordsPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const word = line.trim();
      if (word && !word.startsWith('#') && !word.startsWith('```')) {
        this.stopwords.add(word.toLowerCase());
      }
    }
  }

  /**
   * 执行分类规则
   */
  executeClassification(materials: MaterialInput[]): {
    contentType: ContentType;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  } {
    const allTypes = materials.map(m => m.source_type?.toUpperCase() || '');
    const allNames = materials.map(m => m.name?.toLowerCase() || '');
    const combined = [...allTypes, ...allNames].join(' ');

    // 按优先级检查规则
    for (const rule of this.classificationRules) {
      // 检查精确匹配
      if (rule.sourceTypeMatches && rule.sourceTypeMatches.length > 0) {
        if (allTypes.some(t => rule.sourceTypeMatches!.some(m => m === t))) {
          return {
            contentType: rule.type,
            confidence: 'high',
            reason: `source_type 精确匹配规则 ${rule.type}`
          };
        }
      }

      // 检查关键词
      if (rule.keywords.length > 0) {
        const matched = rule.keywords.some(keyword =>
          combined.toLowerCase().includes(keyword.toLowerCase())
        );

        if (matched) {
          return {
            contentType: rule.type,
            confidence: rule.confidence,
            reason: `关键词匹配规则 ${rule.type}`
          };
        }
      }
    }

    // 默认
    return {
      contentType: 'GENERAL',
      confidence: 'low',
      reason: '无匹配规则，使用默认类型'
    };
  }

  /**
   * 执行路由规则
   */
  executeRouting(
    materials: MaterialInput[],
    contentType: ContentType,
    taskGoal: string
  ): {
    layer: 'drafts' | 'workspace' | 'context';
    confidence: 'high' | 'medium';
    reason: string;
    requiresConfirmation: boolean;
  } {
    const combined = [
      taskGoal,
      ...materials.map(m => m.name || ''),
      ...materials.map(m => m.source_owner || ''),
      ...materials.map(m => m.source_type || '')
    ].join(' ').toLowerCase();

    // 按优先级检查规则
    for (const rule of this.routingRules) {
      let matched = false;

      // 检查条件
      for (const condition of rule.conditions) {
        const conditionLower = condition.toLowerCase();

        // 简单的条件匹配
        if (conditionLower.includes('内容类型')) {
          // 提取类型名称
          const typeMatch = conditionLower.match(/内容类型.*?=.*?(\w+)/);
          if (typeMatch && typeMatch[1].toUpperCase() === contentType) {
            matched = true;
            break;
          }
        } else if (conditionLower.includes('包含')) {
          // 提取关键词
          const keywordsMatch = conditionLower.match(/包含[：:]\s*(.+)/);
          if (keywordsMatch) {
            const keywords = keywordsMatch[1].split(/[,，]/).map(k => k.trim().replace(/"/g, ''));
            if (keywords.some(k => combined.includes(k.toLowerCase()))) {
              matched = true;
              break;
            }
          }
        } else if (conditionLower.includes('非空')) {
          // 检查字段非空
          if (materials.some(m => m.source_owner && m.source_owner.trim().length > 0)) {
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        return {
          layer: rule.layer,
          confidence: 'high',
          reason: rule.reason,
          requiresConfirmation: rule.requiresConfirmation
        };
      }
    }

    // 默认规则
    return {
      layer: 'drafts',
      confidence: 'medium',
      reason: '无匹配规则，使用默认层级（When in doubt, drafts）',
      requiresConfirmation: false
    };
  }

  /**
   * 获取模板
   */
  getTemplate(type: string): TemplateDefinition | null {
    return this.templates.get(type) || this.templates.get('seven-sections') || null;
  }

  /**
   * 获取停用词集合
   */
  getStopwords(): Set<string> {
    return this.stopwords;
  }
}
