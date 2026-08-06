import { modelError, parseModelJson, type ModelJsonRequest, type StructuredModelClient } from "./model-client.js";

interface OpenAICompatibleClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  providerId: string;
  apiKeyName: string;
}

interface ChatPayload {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

export class OpenAICompatibleClient implements StructuredModelClient {
  readonly providerId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    this.providerId = options.providerId;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateJson<T>(input: ModelJsonRequest): Promise<T> {
    if (!this.options.apiKey) throw new Error(`启用 ${this.providerId} Provider 时必须配置 ${this.options.apiKeyName}`);
    if (!this.options.model) throw new Error(`启用 ${this.providerId} Provider 时必须配置模型名称`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `${input.instructions}\n\n# 本轮阶段性响应 JSON Schema\n\n${JSON.stringify(input.schema, null, 2)}\n\n只返回符合该 Schema 的 JSON 对象，不要 Markdown 代码围栏。`,
            },
            { role: "user", content: JSON.stringify(input.content) },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as ChatPayload;
      if (!response.ok) throw modelError(this.providerId, response.status, response.statusText, payload);
      const text = payload.choices?.[0]?.message?.content;
      if (!text?.trim()) throw new Error(`${this.providerId} API 未返回结构化文本输出`);
      return parseModelJson<T>(text, this.providerId);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${this.providerId} API 请求超过 ${this.timeoutMs}ms，Runtime 已停止本轮执行`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
