import { loadLocalEnv } from "./env.js";

export interface ModelProviderStatus {
  provider: string;
  mode: "workspace" | "model";
  ready: boolean;
  model: string | null;
  api_key_env: string | null;
  api_key_configured: boolean;
  base_url: string | null;
  issues: string[];
}

export function inspectModelProviderConfig(env: NodeJS.ProcessEnv = process.env): ModelProviderStatus {
  if (env === process.env) loadLocalEnv();
  const requested = (env.MODEL_PROVIDER ?? "workspace").trim().toLowerCase();
  const provider = normalizeProvider(requested);
  if (provider === "workspace") {
    return {
      provider,
      mode: "workspace",
      ready: false,
      model: null,
      api_key_env: null,
      api_key_configured: false,
      base_url: null,
      issues: ["MODEL_PROVIDER 尚未选择真实模型 Provider"],
    };
  }

  const definition = providerDefinition(provider, env);
  if (!definition) {
    return {
      provider: requested || "workspace",
      mode: "model",
      ready: false,
      model: null,
      api_key_env: null,
      api_key_configured: false,
      base_url: null,
      issues: [`不支持的 MODEL_PROVIDER：${requested}`],
    };
  }

  const issues: string[] = [];
  if (!isConfigured(definition.apiKey)) issues.push(`缺少 ${definition.apiKeyEnv}`);
  if (!isConfigured(definition.model)) issues.push(`缺少 ${definition.modelEnv}`);
  if (definition.baseUrlRequired && !isConfigured(definition.baseUrl)) issues.push(`缺少 ${definition.baseUrlEnv}`);
  return {
    provider,
    mode: "model",
    ready: issues.length === 0,
    model: isConfigured(definition.model) ? definition.model : null,
    api_key_env: definition.apiKeyEnv,
    api_key_configured: isConfigured(definition.apiKey),
    base_url: isConfigured(definition.baseUrl) ? definition.baseUrl : null,
    issues,
  };
}

function normalizeProvider(provider: string): string {
  if (provider === "anthropic") return "claude";
  if (provider === "moonshot") return "kimi";
  if (provider === "openai-compatible") return "compatible";
  return provider || "workspace";
}

function providerDefinition(provider: string, env: NodeJS.ProcessEnv) {
  if (provider === "openai") return {
    apiKey: env.OPENAI_API_KEY ?? env.API_KEY,
    apiKeyEnv: "OPENAI_API_KEY",
    model: env.OPENAI_MODEL ?? env.MODEL_ID,
    modelEnv: "OPENAI_MODEL",
    baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrlRequired: false,
  };
  if (provider === "deepseek") return {
    apiKey: env.DEEPSEEK_API_KEY,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: env.DEEPSEEK_MODEL ?? env.MODEL_ID,
    modelEnv: "DEEPSEEK_MODEL",
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    baseUrlRequired: false,
  };
  if (provider === "kimi") return {
    apiKey: env.KIMI_API_KEY,
    apiKeyEnv: "KIMI_API_KEY",
    model: env.KIMI_MODEL ?? env.MODEL_ID,
    modelEnv: "KIMI_MODEL",
    baseUrl: env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1",
    baseUrlEnv: "KIMI_BASE_URL",
    baseUrlRequired: false,
  };
  if (provider === "claude") return {
    apiKey: env.ANTHROPIC_API_KEY,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: env.CLAUDE_MODEL ?? env.ANTHROPIC_MODEL ?? env.MODEL_ID,
    modelEnv: "CLAUDE_MODEL",
    baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    baseUrlRequired: false,
  };
  if (provider === "compatible") return {
    apiKey: env.MODEL_API_KEY,
    apiKeyEnv: "MODEL_API_KEY",
    model: env.MODEL_ID,
    modelEnv: "MODEL_ID",
    baseUrl: env.MODEL_BASE_URL,
    baseUrlEnv: "MODEL_BASE_URL",
    baseUrlRequired: true,
  };
  return null;
}

function isConfigured(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  return !/(?:你的|your[_ -]?|changeme|sk-xxx|example)/i.test(value.trim());
}
