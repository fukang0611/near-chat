import type {
  AssistantToolGrants,
  PersonalRecord,
  PersonalReminder,
  PersonalTask,
  SyncConflict,
  SyncEntityType,
} from "@near-chat/domain";

export type { PersonalRecord, PersonalReminder, PersonalTask, SyncEntityType };

export interface LocalMemory {
  id: string;
  tier: "SHORT_TERM" | "LONG_TERM";
  scope: "PRIVATE";
  conversationId: string | null;
  kind: string;
  title: string;
  content: string;
  importance: number;
  status: "ACTIVE" | "ARCHIVED" | "DELETED";
  revision: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LocalAssistant {
  id: string;
  name: string;
  description: string;
  category: "GENERAL" | "WRITING" | "ANALYSIS" | "PLANNING";
  instructions: string;
  avatarColor: string;
  modelId: string | null;
  /** 服务端托管的只读授权；本地创建和旧数据缺省均为 false。 */
  toolGrants: AssistantToolGrants;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAssistantThread {
  id: string;
  assistantId: string;
  title: string;
  archived: boolean;
  isDefault: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAssistantMessage {
  id: string;
  assistantId: string;
  threadId: string;
  role: "USER" | "ASSISTANT";
  content: string;
  modelId: string | null;
  sources: Array<Record<string, unknown>>;
  revision: number;
  createdAt: string;
}

export interface EntityByType {
  MEMORY: LocalMemory;
  PERSONAL_TASK: PersonalTask;
  PERSONAL_REMINDER: PersonalReminder;
  PERSONAL_RECORD: PersonalRecord;
  ASSISTANT: LocalAssistant;
  ASSISTANT_THREAD: LocalAssistantThread;
  ASSISTANT_MESSAGE: LocalAssistantMessage;
}

export type MobileEntity = EntityByType[keyof EntityByType];

export interface StoredOutboxOperation {
  operationId: string;
  accountKey: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: "UPSERT" | "DELETE";
  baseRevision: number | null;
  payload: Record<string, unknown>;
  deviceCreatedAt: string;
  attemptCount: number;
  lastError: string | null;
}

export interface StoredSyncConflict {
  operationId: string;
  accountKey: string;
  entityType: SyncEntityType;
  entityId: string;
  reason: SyncConflict["reason"];
  serverRevision: number;
  serverPayload: Record<string, unknown>;
  serverOperation: "UPSERT" | "DELETE";
  localPayload: Record<string, unknown>;
  localOperation: "UPSERT" | "DELETE";
  createdAt: string;
}

export interface SyncProfile {
  accountKey: string;
  installationId: string;
  serverUrl: string;
  token: string;
  userId: string;
  username: string;
}

export type ConnectionPhase = "LOCAL" | "CONNECTED" | "SYNCING" | "CONFLICT" | "ERROR";

export interface MobileSyncState {
  phase: ConnectionPhase;
  message: string;
  pushed: number;
  pulled: number;
  conflicts: number;
}

export const SYNCABLE_TYPES = [
  "MEMORY",
  "PERSONAL_TASK",
  "PERSONAL_REMINDER",
  "PERSONAL_RECORD",
  "ASSISTANT",
  "ASSISTANT_THREAD",
  "ASSISTANT_MESSAGE",
] as const satisfies readonly SyncEntityType[];
