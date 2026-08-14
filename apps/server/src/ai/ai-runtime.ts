import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { PgVector, type VectorType } from "@mastra/pg";
import { embedMany, type EmbeddingModel } from "ai";
import type { AiChatModelSettings, AiRuntimeSettings } from "./ai-settings-service.js";
import { config } from "../config.js";
import { query } from "../database.js";

const KNOWLEDGE_INDEX = "near_chat_knowledge_embeddings";

export type AiRuntimeStatus =
  "DISABLED" | "CONFIGURATION_REQUIRED" | "STARTING" | "READY" | "UNAVAILABLE";

export interface AiCapabilities {
  enabled: boolean;
  status: AiRuntimeStatus;
  reason: string;
  features: {
    knowledgeManagement: boolean;
    knowledgeIndexing: boolean;
    knowledgeSearch: boolean;
    knowledgeAnswer: boolean;
    personalAssistants: boolean;
  };
  provider: {
    chatModel: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number;
  };
}

export interface KnowledgeVectorChunk {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  position: number;
  text: string;
}

export interface KnowledgeVectorMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface RuntimeState {
  settings: AiRuntimeSettings;
  status: AiRuntimeStatus;
  reason: string;
  vector: PgVector | null;
  embeddingModel: EmbeddingModel | null;
  answerAgents: Map<string, Agent>;
  defaultAnswerModelId: string | null;
  mastra: Mastra | null;
}

const bootstrapSettings: AiRuntimeSettings = {
  enabled: false,
  models: [],
  defaultChatModelId: null,
  embedding: {
    baseUrl: null,
    apiKey: null,
    model: null,
    dimensions: config.ai.embedding.dimensions,
  },
  revision: 0,
  embeddingRevision: 0,
  vectorEmbeddingRevision: 0,
  updatedAt: new Date(0).toISOString(),
};

const runtime: RuntimeState = {
  settings: bootstrapSettings,
  status: "DISABLED",
  reason: "AI 增强能力未启用",
  vector: null,
  embeddingModel: null,
  answerAgents: new Map(),
  defaultAnswerModelId: null,
  mastra: null,
};

// 配置切换、索引写入和问答共享同一串行队列，防止热重载在请求中途断开连接。
let operationTail: Promise<void> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function providerConfigured(provider: {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
}): provider is { baseUrl: string | null; apiKey: string | null; model: string } {
  // 本地 OpenAI 兼容服务通常不验证 Key，因此有 baseUrl 也视为可用。
  return Boolean(provider.model && (provider.apiKey || provider.baseUrl));
}

function chatModelConfigured(model: AiChatModelSettings): boolean {
  return model.enabled && Boolean(model.providerModel && (model.apiKey || model.baseUrl));
}

function openAiProvider(provider: { baseUrl: string | null; apiKey: string | null }, name: string) {
  return createOpenAI({
    name,
    baseURL: provider.baseUrl ?? undefined,
    apiKey: provider.apiKey ?? (provider.baseUrl ? "near-chat-local" : undefined),
  });
}

function clearRuntimeObjects(): PgVector | null {
  const vector = runtime.vector;
  runtime.vector = null;
  runtime.embeddingModel = null;
  runtime.answerAgents = new Map();
  runtime.defaultAnswerModelId = null;
  runtime.mastra = null;
  return vector;
}

function createChatAgents(settings: AiRuntimeSettings): {
  answerAgents: Map<string, Agent>;
  mastraAgents: Record<string, Agent>;
  defaultAnswerModelId: string | null;
} {
  const answerAgents = new Map<string, Agent>();
  const mastraAgents: Record<string, Agent> = {};
  for (const model of settings.models.filter(chatModelConfigured)) {
    const agent = new Agent({
      id: `near-chat-knowledge-${model.id}`,
      name: `NearChat 知识助理 · ${model.name}`,
      instructions: [
        "你是 NearChat 团队知识助理。",
        "只根据用户消息中提供的资料片段回答，不得补造事实。",
        "引用资料时使用 [1]、[2] 这样的编号；资料不足时直接说明。",
        "回答应简洁、清楚，默认使用中文。",
      ].join("\n"),
      model: openAiProvider(model, `near-chat-chat-${model.id}`).chat(model.providerModel),
    });
    answerAgents.set(model.id, agent);
    mastraAgents[`model_${model.id.replaceAll("-", "_")}`] = agent;
  }
  const defaultAnswerModelId =
    (settings.defaultChatModelId && answerAgents.has(settings.defaultChatModelId)
      ? settings.defaultChatModelId
      : answerAgents.keys().next().value) ?? null;
  return { answerAgents, mastraAgents, defaultAnswerModelId };
}

export class AiFeatureUnavailableError extends Error {
  constructor(message = runtime.reason) {
    super(message);
  }
}

/** 能力快照不包含密钥或服务地址，普通客户端可安全读取。 */
export function getAiCapabilities(): AiCapabilities {
  const vectorReady =
    runtime.status === "READY" && Boolean(runtime.vector && runtime.embeddingModel);
  const defaultModel = runtime.settings.models.find(
    (model) => model.id === runtime.defaultAnswerModelId,
  );
  return {
    enabled: runtime.settings.enabled,
    status: runtime.status,
    reason: runtime.reason,
    features: {
      knowledgeManagement: runtime.settings.enabled,
      knowledgeIndexing: vectorReady,
      knowledgeSearch: vectorReady,
      knowledgeAnswer: vectorReady && runtime.answerAgents.size > 0,
      personalAssistants:
        runtime.settings.enabled && runtime.status === "READY" && runtime.answerAgents.size > 0,
    },
    provider: {
      chatModel: defaultModel?.providerModel ?? null,
      embeddingModel: providerConfigured(runtime.settings.embedding)
        ? runtime.settings.embedding.model
        : null,
      embeddingDimensions: runtime.settings.embedding.dimensions,
    },
  };
}

export interface AiRuntimeApplyResult {
  capabilities: AiCapabilities;
  indexRecreated: boolean;
}

async function applyRuntimeSettings(settings: AiRuntimeSettings): Promise<AiRuntimeApplyResult> {
  const previousVector = clearRuntimeObjects();
  await previousVector?.disconnect().catch((error) => {
    console.warn("Failed to close previous AI vector connection:", error);
  });
  runtime.settings = settings;

  if (!settings.enabled) {
    runtime.status = "DISABLED";
    runtime.reason = "AI 增强能力未启用";
    return { capabilities: getAiCapabilities(), indexRecreated: false };
  }

  const { answerAgents, mastraAgents, defaultAnswerModelId } = createChatAgents(settings);
  runtime.answerAgents = answerAgents;
  runtime.defaultAnswerModelId = defaultAnswerModelId;
  runtime.mastra = new Mastra({
    agents: mastraAgents,
    // NearChat 自行持久化助理消息与知识来源，不启用 Mastra 会话记忆。
    logger: false,
  });

  if (!providerConfigured(settings.embedding)) {
    runtime.status = answerAgents.size > 0 ? "READY" : "CONFIGURATION_REQUIRED";
    runtime.reason =
      answerAgents.size > 0
        ? `个人助理已就绪，可使用 ${answerAgents.size} 个对话模型；知识库需配置 Embedding`
        : "请先配置可用的对话模型或 Embedding 模型";
    return { capabilities: getAiCapabilities(), indexRecreated: false };
  }

  runtime.status = "STARTING";
  runtime.reason = "AI 能力正在应用新配置";
  let initializingVector: PgVector | null = null;
  let indexRecreated = false;
  try {
    // 只有全局 AI 开关开启后才要求 pgvector，普通聊天部署仍可使用标准 PostgreSQL。
    await query("CREATE EXTENSION IF NOT EXISTS vector");
    const vector = new PgVector({
      id: "near-chat-knowledge-vector",
      connectionString: config.databaseUrl,
      schemaName: "near_chat_ai",
    });
    initializingVector = vector;

    const vectorType: VectorType = settings.embedding.dimensions > 2000 ? "halfvec" : "vector";
    const indexes = await vector.listIndexes();
    if (indexes.includes(KNOWLEDGE_INDEX)) {
      const index = await vector.describeIndex({ indexName: KNOWLEDGE_INDEX });
      const staleModel = settings.vectorEmbeddingRevision !== settings.embeddingRevision;
      if (
        staleModel ||
        index.dimension !== settings.embedding.dimensions ||
        index.vectorType !== vectorType
      ) {
        await vector.deleteIndex({ indexName: KNOWLEDGE_INDEX });
        indexRecreated = true;
      }
    } else {
      indexRecreated = true;
    }
    await vector.createIndex({
      indexName: KNOWLEDGE_INDEX,
      dimension: settings.embedding.dimensions,
      metric: "cosine",
      vectorType,
      indexConfig: { type: "hnsw", hnsw: { m: 16, efConstruction: 64 } },
      metadataIndexes: ["knowledgeBaseId", "documentId"],
    });

    const embeddingModel = openAiProvider(settings.embedding, "near-chat-embedding").embedding(
      settings.embedding.model,
    );
    runtime.vector = vector;
    runtime.embeddingModel = embeddingModel;
    runtime.mastra = new Mastra({
      vectors: { knowledgeVector: vector },
      agents: mastraAgents,
      // NearChat 自行持久化任务与来源；此处不启用 Mastra 会话记忆。
      logger: false,
    });
    runtime.status = "READY";
    runtime.reason =
      answerAgents.size > 0
        ? `AI 已就绪，可使用 ${answerAgents.size} 个对话模型`
        : "知识库检索已就绪；请配置可用的对话模型后生成答案";
    console.log(
      `NearChat AI runtime ready (${settings.embedding.model}, ${answerAgents.size} chat models)`,
    );
  } catch (error) {
    await initializingVector?.disconnect().catch(() => undefined);
    runtime.vector = null;
    runtime.embeddingModel = null;
    runtime.mastra = new Mastra({ agents: mastraAgents, logger: false });
    runtime.status = answerAgents.size > 0 ? "READY" : "UNAVAILABLE";
    runtime.reason =
      answerAgents.size > 0
        ? `个人助理已就绪，可使用 ${answerAgents.size} 个对话模型；知识库向量服务暂不可用`
        : "AI 服务暂时不可用，聊天功能不受影响";
    console.warn("NearChat AI runtime unavailable; core chat remains active:", error);
  }
  return { capabilities: getAiCapabilities(), indexRecreated };
}

/** 保存后调用此方法即可热切换，无需重启 Node 进程。 */
export function reconfigureAiRuntime(settings: AiRuntimeSettings): Promise<AiRuntimeApplyResult> {
  return serialized(() => applyRuntimeSettings(settings));
}

export const initializeAiRuntime = reconfigureAiRuntime;

function readyRuntime(): {
  vector: PgVector;
  embeddingModel: EmbeddingModel;
  dimensions: number;
} {
  if (runtime.status !== "READY" || !runtime.vector || !runtime.embeddingModel) {
    throw new AiFeatureUnavailableError();
  }
  return {
    vector: runtime.vector,
    embeddingModel: runtime.embeddingModel,
    dimensions: runtime.settings.embedding.dimensions,
  };
}

async function embedTexts(
  model: EmbeddingModel,
  dimensions: number,
  values: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < values.length; offset += 64) {
    const result = await embedMany({ model, values: values.slice(offset, offset + 64) });
    vectors.push(...result.embeddings);
  }
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new Error(`Embedding 返回 ${vector.length} 维，管理配置要求 ${dimensions} 维`);
    }
  }
  return vectors;
}

export async function replaceDocumentVectors(chunks: KnowledgeVectorChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  return serialized(async () => {
    const { vector, embeddingModel, dimensions } = readyRuntime();
    const vectors = await embedTexts(
      embeddingModel,
      dimensions,
      chunks.map((chunk) => chunk.text),
    );
    await vector.upsert({
      indexName: KNOWLEDGE_INDEX,
      vectors,
      ids: chunks.map((chunk) => chunk.id),
      metadata: chunks.map((chunk) => ({
        knowledgeBaseId: chunk.knowledgeBaseId,
        documentId: chunk.documentId,
        position: chunk.position,
      })),
      deleteFilter: { documentId: chunks[0]!.documentId },
    });
  });
}

export function deleteDocumentVectors(documentId: string): Promise<void> {
  return serialized(async () => {
    const { vector } = readyRuntime();
    await vector.deleteVectors({ indexName: KNOWLEDGE_INDEX, filter: { documentId } });
  });
}

export function searchKnowledgeVectors(
  knowledgeBaseId: string,
  text: string,
  topK: number,
): Promise<KnowledgeVectorMatch[]> {
  return serialized(async () => {
    const { vector, embeddingModel, dimensions } = readyRuntime();
    const [queryVector] = await embedTexts(embeddingModel, dimensions, [text]);
    const matches = await vector.query({
      indexName: KNOWLEDGE_INDEX,
      queryVector,
      topK,
      filter: { knowledgeBaseId },
      minScore: 0.15,
    });
    return matches.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata ?? {},
    }));
  });
}

export function generateKnowledgeAnswer(prompt: string, modelId?: string): Promise<string> {
  return serialized(async () => {
    const agent =
      (modelId ? runtime.answerAgents.get(modelId) : undefined) ??
      (runtime.defaultAnswerModelId
        ? runtime.answerAgents.get(runtime.defaultAnswerModelId)
        : undefined);
    if (!agent) {
      throw new AiFeatureUnavailableError("未配置可用的对话模型，当前仅支持知识库检索");
    }
    const result = await agent.generate(prompt);
    return result.text.trim();
  });
}

export type PersonalAssistantMessage =
  { role: "user"; content: string } | { role: "assistant"; content: string };

/**
 * 个人助理按请求动态组合角色说明，但仍复用管理员配置的 OpenAI 兼容模型。
 * 会话历史由 NearChat 数据库维护，避免运行时重载造成上下文丢失。
 */
export function generatePersonalAssistantReply(input: {
  assistantId: string;
  assistantName: string;
  instructions: string;
  modelId: string;
  messages: PersonalAssistantMessage[];
}): Promise<string> {
  return serialized(async () => {
    if (!getAiCapabilities().features.personalAssistants) {
      throw new AiFeatureUnavailableError("个人助理尚未就绪，请检查 AI 对话模型配置");
    }
    const model = runtime.settings.models.find(
      (candidate) => candidate.id === input.modelId && chatModelConfigured(candidate),
    );
    if (!model) throw new AiFeatureUnavailableError("所选对话模型当前不可用");

    const agent = new Agent({
      id: `near-chat-assistant-${input.assistantId}`,
      name: input.assistantName,
      instructions: [
        "你是 NearChat 中由当前用户创建的私人智能助理。",
        "默认使用中文，表达清楚、自然，并严格遵循下方角色说明。",
        "你目前没有执行外部操作、浏览网页、发送消息或修改文件的工具；不得声称已经完成这些动作。",
        "不确定的信息应明确说明，不得捏造用户、团队或系统内部数据。",
        "",
        "角色说明：",
        input.instructions,
      ].join("\n"),
      model: openAiProvider(model, `near-chat-assistant-${model.id}`).chat(model.providerModel),
    });
    const result = await agent.generate(input.messages);
    const text = result.text.trim();
    if (!text) throw new Error("模型未返回有效文本");
    return text;
  });
}

export function shutdownAiRuntime(): Promise<void> {
  return serialized(async () => {
    const vector = clearRuntimeObjects();
    runtime.status = "DISABLED";
    runtime.reason = "AI 运行时已停止";
    if (vector) await vector.disconnect();
  });
}
