/**
 * 摄入配置 - 控制内容分类、路由、文件决策等行为
 *
 * 设计原则：
 * - 默认配置保留当前行为（向后兼容）
 * - 所有新能力可选启用
 * - 渐进式增强
 */

export interface IngestConfig {
  // 内容分类
  classification: {
    use_ai_assist: boolean;           // 启用AI辅助分类
    confidence_threshold: number;     // 置信度阈值（0-1）
  };

  // 目录路由
  routing: {
    enable_smart_routing: boolean;    // 启用智能路由
    default_layer: 'drafts' | 'workspace';  // 默认层级
    require_context_confirmation: boolean;  // context层需确认
  };

  // 文件决策
  file_decision: {
    append_threshold_days: number;    // 追加阈值（默认7天）
    enable_semantic_match: boolean;   // 启用语义匹配
    semantic_threshold: number;       // 语义相似度阈值（0-1）
  };

  // 索引维护
  indexing: {
    auto_update: boolean;             // 自动更新索引
    include_summary: boolean;         // 包含文件摘要
  };

  // 模板系统（新增）
  template: {
    enable_flexible_template: boolean;  // 启用灵活模板
    use_seven_sections_default: boolean; // 默认使用7章节
  };

  // 用户交互
  confirmation: {
    require_layer: boolean;           // 层级路由确认
    require_filename: boolean;        // 文件名确认
    require_append: boolean;          // 追加操作确认
  };
}

/**
 * 默认配置（保留当前行为）
 */
export const DEFAULT_CONFIG: IngestConfig = {
  classification: {
    use_ai_assist: false,             // 默认不启用AI
    confidence_threshold: 0.7
  },
  routing: {
    enable_smart_routing: false,      // 默认固定drafts
    default_layer: 'drafts',
    require_context_confirmation: true
  },
  file_decision: {
    append_threshold_days: 7,
    enable_semantic_match: false,     // 默认不启用语义匹配
    semantic_threshold: 0.7
  },
  indexing: {
    auto_update: true,                // 自动更新索引
    include_summary: true
  },
  template: {
    enable_flexible_template: false,  // 默认不启用灵活模板
    use_seven_sections_default: true  // 使用7章节
  },
  confirmation: {
    require_layer: false,             // 默认不需要确认
    require_filename: false,
    require_append: false
  }
};

/**
 * 推荐配置（启用所有智能功能）
 */
export const RECOMMENDED_CONFIG: IngestConfig = {
  classification: {
    use_ai_assist: true,              // 启用AI辅助
    confidence_threshold: 0.7
  },
  routing: {
    enable_smart_routing: true,       // 启用智能路由
    default_layer: 'drafts',
    require_context_confirmation: true
  },
  file_decision: {
    append_threshold_days: 7,
    enable_semantic_match: true,      // 启用语义匹配
    semantic_threshold: 0.7
  },
  indexing: {
    auto_update: true,
    include_summary: true
  },
  template: {
    enable_flexible_template: true,   // 启用灵活模板
    use_seven_sections_default: false
  },
  confirmation: {
    require_layer: false,             // 关键决策点确认
    require_filename: false,
    require_append: false
  }
};

/**
 * 合并配置（用户配置 + 默认配置）
 */
export function mergeConfig(userConfig: Partial<IngestConfig> = {}): IngestConfig {
  return {
    classification: {
      ...DEFAULT_CONFIG.classification,
      ...userConfig.classification
    },
    routing: {
      ...DEFAULT_CONFIG.routing,
      ...userConfig.routing
    },
    file_decision: {
      ...DEFAULT_CONFIG.file_decision,
      ...userConfig.file_decision
    },
    indexing: {
      ...DEFAULT_CONFIG.indexing,
      ...userConfig.indexing
    },
    template: {
      ...DEFAULT_CONFIG.template,
      ...userConfig.template
    },
    confirmation: {
      ...DEFAULT_CONFIG.confirmation,
      ...userConfig.confirmation
    }
  };
}
