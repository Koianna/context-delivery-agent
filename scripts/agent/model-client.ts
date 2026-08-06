export interface ModelJsonRequest {
  name: string;
  schema: Record<string, unknown>;
  instructions: string;
  content: unknown;
}

export interface StructuredModelClient {
  readonly providerId: string;
  generateJson<T>(input: ModelJsonRequest): Promise<T>;
}

export function parseModelJson<T>(text: string, providerLabel: string): T {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    throw new Error(`${providerLabel} 返回的 JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function modelError(providerLabel: string, status: number, statusText: string, payload: unknown): Error {
  const message = payload && typeof payload === "object" && "error" in payload
    ? readErrorMessage((payload as { error?: unknown }).error)
    : undefined;
  return new Error(`${providerLabel} API 请求失败 (${status}): ${message ?? statusText}`);
}

function readErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return undefined;
}
