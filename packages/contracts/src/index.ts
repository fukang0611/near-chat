/**
 * Web、Electron、后续 Android 客户端与服务端共同使用的稳定协议。
 * 本包只包含可序列化类型和常量，不依赖 Node、DOM 或具体存储实现。
 */

export const MEMORY_SCOPES = ["PRIVATE", "CONVERSATION"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = [
  "PREFERENCE",
  "PERSON",
  "PROJECT",
  "DECISION",
  "PROCEDURE",
  "GOAL",
  "NOTE",
  "TASK_CONTEXT",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TIERS = ["SHORT_TERM", "LONG_TERM"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export interface MemorySourceReference {
  type: "MESSAGE" | "ASSISTANT_MESSAGE" | "FILE" | "TASK" | "REMINDER" | "MANUAL";
  id: string | null;
  conversationId: string | null;
  label: string;
  excerpt: string | null;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  tier: MemoryTier;
  scope: MemoryScope;
  conversationId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  revision: number;
  sources: MemorySourceReference[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPage {
  memories: MemoryRecord[];
  total: number;
  offset: number;
  hasMore: boolean;
  /** 未配置或暂时无法调用 Embedding 时固定为 KEYWORD。 */
  searchMode: "KEYWORD" | "HYBRID";
}

export interface CreateMemoryInput {
  title: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  /** 省略时按长期记忆保存；短期记忆由服务端统一设置 7 天有效期。 */
  tier?: MemoryTier;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  /** 客户端最后读取的版本，用于阻止覆盖其他终端刚完成的修改。 */
  baseRevision: number;
}

export const MEMORY_CANDIDATE_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const;
export type MemoryCandidateStatus = (typeof MEMORY_CANDIDATE_STATUSES)[number];

/** 从消息中提取、尚待用户确认的私人记忆草稿。 */
export interface MemoryCandidate {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  status: MemoryCandidateStatus;
  source: MemorySourceReference;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCandidatePage {
  candidates: MemoryCandidate[];
  total: number;
}

export interface MemorySettings {
  /** 自动识别“记住 / 记一下”等明确表达；普通聊天不会调用模型。 */
  explicitCaptureEnabled: boolean;
  shortTermRetentionDays: 7;
  updatedAt: string | null;
}

export interface AgentToolContext {
  requesterUserId: string;
  assistantId: string;
  invocationId: string | null;
  visibility: "PRIVATE_PREVIEW" | "CONVERSATION_REPLY";
  allowedConversationIds: string[];
  allowPrivateMemory: boolean;
}

export interface AgentRuntimeRequest {
  modelId: string | null;
  instructions: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  toolContext: AgentToolContext;
}

export interface AgentRuntimeResponse {
  text: string;
  modelId: string | null;
  sourceIds: string[];
}

export interface AgentRuntime {
  generate(request: AgentRuntimeRequest): Promise<AgentRuntimeResponse>;
  embed?(texts: string[]): Promise<number[][]>;
}

export const SYNC_ENTITY_TYPES = [
  "MEMORY",
  "PERSONAL_TASK",
  "PERSONAL_REMINDER",
  "PERSONAL_RECORD",
  "ASSISTANT",
  "ASSISTANT_THREAD",
  "ASSISTANT_MESSAGE",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export interface SyncOperation<TPayload = unknown> {
  operationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: "UPSERT" | "DELETE";
  baseRevision: number | null;
  payload: TPayload;
  deviceCreatedAt: string;
}
