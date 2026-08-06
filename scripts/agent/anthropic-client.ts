import { modelError, parseModelJson, type ModelJsonRequest, type StructuredModelClient } from "./model-client.js";

interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  apiKeyName?: string;
}

interface AnthropicPayload {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

export class AnthropicMessagesClient implements StructuredModelClient {
  readonly providerId = "claude";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateJson<T>(input: ModelJsonRequest): Promise<T> {
    if (!this.options.apiKey) throw new Error(`启用 Claude Provider 时必须配置 ${this.options.apiKeyName ?? "ANTHROPIC_API_KEY"}`);
    if (!this.options.model) throw new Error("启用 Claude Provider 时必须配置 CLAUDE_MODEL 或 ANTHROPIC_MODEL");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 16_000,
          system: `${input.instructions}\n\n只返回符合要求的 JSON 对象，不要 Markdown 代码围栏。`,
          messages: [{ role: "user", content: JSON.stringify({ task: input.name, schema: input.schema, content: input.content }) }],
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as AnthropicPayload;
      if (!response.ok) throw modelError("Claude", response.status, response.statusText, payload);
      const text = payload.content?.find((item) => item.type === "text")?.text;
      if (!text?.trim()) throw new Error("Claude API 未返回结构化文本输出");
      return parseModelJson<T>(text, "Claude");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Claude API 请求超过 ${this.timeoutMs}ms，Runtime 已停止本轮执行`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
