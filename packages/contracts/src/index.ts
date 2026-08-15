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
