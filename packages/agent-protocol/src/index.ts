import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentRuntimeResponse,
  ToolCall,
  ToolResult,
} from "@near-chat/contracts";

export interface OpenAiCompatibleSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface AgentHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
}

export interface AgentHttpResponse {
  status: number;
  data: unknown;
}

/** Android 可注入 CapacitorHttp，同时让协议包保持平台无关。 */
export type AgentHttpTransport = (request: AgentHttpRequest) => Promise<AgentHttpResponse>;

export type ToolExecutor = (
  argumentsValue: Record<string, unknown>,
  call: ToolCall,
) => unknown | Promise<unknown>;

export interface LocalAgentRuntimeRequest extends AgentRuntimeRequest {
  /** 已由本地权限边界筛选过的来源 ID，仅用于结果追溯。 */
  sourceIds?: string[];
}

type ChatCompletionBody = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type EmbeddingBody = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
};

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function asBody<T>(value: unknown): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error("模型服务返回了无法解析的数据");
    }
  }
  return value as T;
}

async function fetchTransport(request: AgentHttpRequest): Promise<AgentHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // 保留原始响应，后续会给出稳定错误。
      }
    }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("模型请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function serviceError(status: number, body: { error?: { message?: string } }, fallback: string) {
  const detail = body.error?.message?.trim();
  return new Error(detail ? `${fallback}（${status}）：${detail}` : `${fallback}（${status}）`);
}

/**
 * 轻量移动端 Agent Runtime。API Key 由宿主从 Keystore 读取后以内存参数传入，
 * 本包不持久化凭据，也不接受模型声明的用户或权限范围。
 */
export class LocalAgentRuntime implements AgentRuntime {
  private readonly settings: OpenAiCompatibleSettings;
  private readonly transport: AgentHttpTransport;
  private readonly toolExecutors: Readonly<Record<string, ToolExecutor>>;

  constructor(
    settings: OpenAiCompatibleSettings,
    transport: AgentHttpTransport = fetchTransport,
    toolExecutors: Readonly<Record<string, ToolExecutor>> = {},
  ) {
    this.settings = settings;
    this.transport = transport;
    this.toolExecutors = toolExecutors;
  }

  async generate(request: LocalAgentRuntimeRequest): Promise<AgentRuntimeResponse> {
    const response = await this.transport({
      url: endpoint(this.settings.baseUrl, "/chat/completions"),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: {
        model: request.modelId ?? this.settings.model,
        messages: [{ role: "system", content: request.instructions }, ...request.messages],
      },
      timeoutMs: this.settings.timeoutMs ?? 45_000,
    });
    const body = asBody<ChatCompletionBody>(response.data);
    if (response.status < 200 || response.status >= 300) {
      throw serviceError(response.status, body, "本地助理模型请求失败");
    }
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("本地助理模型未返回文本结果");
    return {
      text,
      modelId: request.modelId ?? this.settings.model,
      sourceIds: [...new Set(request.sourceIds ?? [])],
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const response = await this.transport({
      url: endpoint(this.settings.baseUrl, "/embeddings"),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: { model: this.settings.model, input: texts },
      timeoutMs: this.settings.timeoutMs ?? 45_000,
    });
    const body = asBody<EmbeddingBody>(response.data);
    if (response.status < 200 || response.status >= 300) {
      throw serviceError(response.status, body, "Embedding 请求失败");
    }
    const vectors = [...(body.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((entry) => entry.embedding)
      .filter((entry): entry is number[] => Array.isArray(entry));
    if (vectors.length !== texts.length) throw new Error("Embedding 服务返回的向量数量不完整");
    return vectors;
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    const executor = Object.prototype.hasOwnProperty.call(this.toolExecutors, call.name)
      ? this.toolExecutors[call.name]
      : undefined;
    if (!executor) {
      return {
        callId: call.id,
        name: call.name,
        output: null,
        error: `本地工具未授权或不存在：${call.name}`,
      };
    }
    try {
      return {
        callId: call.id,
        name: call.name,
        output: await executor(call.arguments, call),
      };
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        output: null,
        error: error instanceof Error ? error.message : "本地工具执行失败",
      };
    }
  }
}
