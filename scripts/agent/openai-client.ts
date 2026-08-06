import { modelError, parseModelJson, type ModelJsonRequest, type StructuredModelClient } from "./model-client.js";

interface OpenAIClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ResponsesApiPayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

export class OpenAIResponsesClient implements StructuredModelClient {
  readonly providerId = "openai";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateJson<T>(input: ModelJsonRequest): Promise<T> {
    if (!this.options.apiKey) throw new Error("启用 OpenAI Provider 时必须配置 OPENAI_API_KEY");
    if (!this.options.model) throw new Error("启用 OpenAI Provider 时必须配置 OPENAI_MODEL");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          instructions: input.instructions,
          input: JSON.stringify(input.content),
          text: {
            format: {
              type: "json_schema",
              name: input.name,
              strict: true,
              schema: input.schema,
            },
          },
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as ResponsesApiPayload;
      if (!response.ok) {
        throw modelError("OpenAI", response.status, response.statusText, payload);
      }
      const text = extractOutputText(payload);
      if (!text) throw new Error("OpenAI API 未返回结构化文本输出");
      return parseModelJson<T>(text, "OpenAI");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OpenAI API 请求超过 ${this.timeoutMs}ms，Runtime 已停止本轮执行`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractOutputText(payload: ResponsesApiPayload): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}
