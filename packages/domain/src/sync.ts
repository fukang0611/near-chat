import type { PersonalEntityType } from "./personal.js";

export const SYNC_ENTITY_TYPES = [
  "MEMORY",
  ...(["PERSONAL_TASK", "PERSONAL_REMINDER", "PERSONAL_RECORD"] as PersonalEntityType[]),
  "ASSISTANT",
  "ASSISTANT_THREAD",
  "ASSISTANT_MESSAGE",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];
export type SyncOperationKind = "UPSERT" | "DELETE";

/**
 * 助理检索授权由服务端管理。移动端只消费同步下来的快照，不能通过同步回推扩大授权。
 */
export interface AssistantToolGrants {
  crossConversationSearch: boolean;
  privateMemoryRead: boolean;
}

export const DEFAULT_ASSISTANT_TOOL_GRANTS: Readonly<AssistantToolGrants> = Object.freeze({
  crossConversationSearch: false,
  privateMemoryRead: false,
});

export interface SyncOperation<TPayload = Record<string, unknown>> {
  operationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationKind;
  baseRevision: number | null;
  payload: TPayload;
  deviceCreatedAt: string;
}

export interface SyncChange<TPayload = Record<string, unknown>> {
  sequence: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationKind;
  revision: number;
  payload: TPayload;
  occurredAt: string;
}

/** applied 保持 SyncChange 兼容，同时携带可供客户端 ACK outbox 的 operationId。 */
export interface SyncAppliedChange<
  TPayload = Record<string, unknown>,
> extends SyncChange<TPayload> {
  operationId: string;
}

export type SyncConflictReason =
  | "STALE_REVISION"
  | "MEMORY_MERGE_REQUIRED"
  | "COMPLETED_MONOTONIC"
  | "ENTITY_DELETED"
  | "INVALID_PAYLOAD"
  | "OPERATION_ID_REUSED"
  | "APPEND_ONLY";
export interface SyncConflict {
  operationId: string;
  entityType: SyncEntityType;
  entityId: string;
  reason: SyncConflictReason;
  serverRevision: number;
  serverPayload: Record<string, unknown>;
}

export interface SyncPushResult {
  applied: SyncAppliedChange[];
  conflicts: SyncConflict[];
  /** 首次成功与命中幂等记录的成功操作都会 ACK。 */
  acknowledgedOperationIds: string[];
}

export type MemorySyncConflictStatus = "PENDING" | "RESOLVED" | "DISMISSED";

export interface MemorySyncConflictResolution {
  operationId: string;
  memoryId: string;
  status: Exclude<MemorySyncConflictStatus, "PENDING">;
  resolvedAt: string;
}

export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

export interface SyncEntityVersion {
  revision: number;
  deleted: boolean;
  completedAt?: string | null;
}

export type SyncOperationResolution =
  | { kind: "APPLY"; revision: number; deleted: boolean }
  | { kind: "CONFLICT"; reason: SyncConflictReason; serverRevision: number };

/**
 * 所有同步实体共用的版本门禁。数据库适配器只在得到 APPLY 后写真实业务表，
 * 避免快照表和业务表各自判断 revision 而产生分叉。
 */
export function resolveSyncOperation(
  operation: SyncOperation,
  current: SyncEntityVersion | null,
): SyncOperationResolution {
  if (!current) {
    if (operation.operation === "DELETE" || operation.baseRevision !== null) {
      return { kind: "CONFLICT", reason: "STALE_REVISION", serverRevision: 0 };
    }
    return { kind: "APPLY", revision: 1, deleted: false };
  }
  if (current.deleted) {
    return {
      kind: "CONFLICT",
      reason: "ENTITY_DELETED",
      serverRevision: current.revision,
    };
  }
  if (operation.baseRevision !== current.revision) {
    return {
      kind: "CONFLICT",
      reason: operation.entityType === "MEMORY" ? "MEMORY_MERGE_REQUIRED" : "STALE_REVISION",
      serverRevision: current.revision,
    };
  }
  if (
    (operation.entityType === "PERSONAL_TASK" || operation.entityType === "PERSONAL_REMINDER") &&
    current.completedAt &&
    operation.operation === "UPSERT" &&
    operation.payload.completedAt === null
  ) {
    return {
      kind: "CONFLICT",
      reason: "COMPLETED_MONOTONIC",
      serverRevision: current.revision,
    };
  }
  return {
    kind: "APPLY",
    revision: current.revision + 1,
    deleted: operation.operation === "DELETE",
  };
}
