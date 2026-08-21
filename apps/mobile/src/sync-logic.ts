import type { SyncChange, SyncOperation } from "@near-chat/domain";
import type { StoredSyncConflict } from "./models";

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("团队地址不能为空");
  const url = new URL(trimmed);
  if (!/^https?:$/.test(url.protocol)) throw new Error("团队地址只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("团队地址不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("团队地址不能包含查询参数或片段");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function normalizeModelBaseUrl(value: string, allowCleartext: boolean): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("模型地址不能为空");
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("模型地址只支持 HTTP 或 HTTPS");
  }
  if (url.protocol === "http:" && !allowCleartext) {
    throw new Error("正式构建只允许 HTTPS 模型地址");
  }
  if (url.username || url.password) throw new Error("模型地址不能包含用户名或密码");
  if (url.search || url.hash) throw new Error("模型地址不能包含查询参数或片段");
  return url.toString().replace(/\/$/, "");
}

/** 游标与 outbox 同时按服务器、用户和物理安装隔离。 */
export function accountNamespace(
  serverUrl: string,
  userId: string,
  installationId: string,
): string {
  return JSON.stringify([normalizeServerUrl(serverUrl), userId, installationId]);
}

export function resolveBaseRevision(
  revision: number,
  options: { baseRevision?: number | null },
): number | null {
  return Object.prototype.hasOwnProperty.call(options, "baseRevision")
    ? (options.baseRevision ?? null)
    : revision > 0
      ? revision
      : null;
}

/** 冲突返回的 0 表示服务端无现存版本，不能作为要求正整数的 baseRevision 发送。 */
export function conflictBaseRevision(serverRevision: number): number | null {
  return Number.isInteger(serverRevision) && serverRevision > 0 ? serverRevision : null;
}

export function conflictRetryPlan(conflict: StoredSyncConflict): {
  operation: "UPSERT" | "DELETE";
  baseRevision: number | null;
  serverDeleted: boolean;
} {
  return {
    operation: conflict.localOperation ?? "UPSERT",
    baseRevision: conflictBaseRevision(conflict.serverRevision),
    serverDeleted: isConflictServerDeleted(conflict),
  };
}

export interface RefreshedConflict {
  conflict: StoredSyncConflict;
  /** 远端状态已无损写入冲突草稿后即可推进 cursor。 */
  cursorCanAdvance: boolean;
  changed: boolean;
}

/**
 * pull 可以在冲突存在期间继续前进，但必须先把最新权威 UPSERT 写回冲突草稿。
 * DELETE 以独立 serverOperation 持久化，采用服务器时可立即执行 tombstone。
 */
export function refreshConflictFromRemoteChange(
  conflict: StoredSyncConflict,
  change: SyncChange,
): RefreshedConflict {
  if (change.entityType !== conflict.entityType || change.entityId !== conflict.entityId) {
    throw new Error("远端变更与本地冲突实体不一致");
  }
  if (change.operation === "DELETE") {
    const refreshed: StoredSyncConflict = {
      ...conflict,
      serverOperation: "DELETE",
      serverRevision: change.revision,
      serverPayload: {
        ...change.payload,
        deletedAt:
          typeof change.payload.deletedAt === "string"
            ? change.payload.deletedAt
            : change.occurredAt,
      },
    };
    return {
      conflict: refreshed,
      cursorCanAdvance: true,
      changed:
        conflict.serverOperation !== "DELETE" ||
        conflict.serverRevision !== refreshed.serverRevision ||
        JSON.stringify(conflict.serverPayload) !== JSON.stringify(refreshed.serverPayload),
    };
  }
  if (change.revision < conflict.serverRevision) {
    return { conflict, cursorCanAdvance: true, changed: false };
  }
  const refreshed: StoredSyncConflict = {
    ...conflict,
    serverOperation: "UPSERT",
    serverRevision: change.revision,
    serverPayload: { ...change.payload },
  };
  return {
    conflict: refreshed,
    cursorCanAdvance: true,
    changed:
      refreshed.serverRevision !== conflict.serverRevision ||
      JSON.stringify(refreshed.serverPayload) !== JSON.stringify(conflict.serverPayload),
  };
}

export function localNamespace(installationId: string): string {
  return JSON.stringify(["LOCAL", installationId]);
}

export function chunkOperations<T>(operations: T[], size = 100): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > 100)
    throw new Error("同步批次必须在 1 到 100 之间");
  const chunks: T[][] = [];
  for (let index = 0; index < operations.length; index += size) {
    chunks.push(operations.slice(index, index + size));
  }
  return chunks;
}

/** express 的同步入口保留 1MiB 防护；客户端以 768KiB 给 JSON/编码差异留余量。 */
export const SYNC_PUSH_BODY_BUDGET_BYTES = 768 * 1024;

function syncPushBodyBytes(deviceId: string, operations: readonly SyncOperation[]): number {
  return new TextEncoder().encode(JSON.stringify({ deviceId, operations })).byteLength;
}

export function splitSyncPushBatches(
  deviceId: string,
  operations: readonly SyncOperation[],
  maxBytes = SYNC_PUSH_BODY_BUDGET_BYTES,
): SyncOperation[][] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("同步字节预算无效");
  const batches: SyncOperation[][] = [];
  let current: SyncOperation[] = [];
  for (const operation of operations) {
    const candidate = [...current, operation];
    if (syncPushBodyBytes(deviceId, candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (!current.length) throw new Error("单项同步数据超过安全传输上限，请缩短内容后重试");
    batches.push(current);
    current = [operation];
    if (syncPushBodyBytes(deviceId, current) > maxBytes) {
      throw new Error("单项同步数据超过安全传输上限，请缩短内容后重试");
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** 同一实体只并行发送最早一条，避免服务端返回不含 operationId 的 applied 结果产生歧义。 */
export function selectUniqueEntityOperations<
  T extends { entityType: string; entityId: string; operation?: string },
>(operations: T[], limit = 100): T[] {
  const selected: Array<{ operation: T; sourceIndex: number }> = [];
  const entities = new Set<string>();
  for (const [sourceIndex, operation] of operations.entries()) {
    const key = `${operation.entityType}\u0000${operation.entityId}`;
    if (entities.has(key)) continue;
    entities.add(key);
    selected.push({ operation, sourceIndex });
  }
  const priority = (value: T): number => {
    const deleting = value.operation === "DELETE";
    if (value.entityType === "ASSISTANT") return deleting ? 2 : 0;
    if (value.entityType === "ASSISTANT_THREAD") return 1;
    if (value.entityType === "ASSISTANT_MESSAGE") return deleting ? 0 : 2;
    return 0;
  };
  return selected
    .sort(
      (left, right) =>
        priority(left.operation) - priority(right.operation) ||
        left.sourceIndex - right.sourceIndex,
    )
    .slice(0, limit)
    .map(({ operation }) => operation);
}

export function asSyncOperation(operation: {
  operationId: string;
  entityType: SyncOperation["entityType"];
  entityId: string;
  operation: SyncOperation["operation"];
  baseRevision: number | null;
  payload: Record<string, unknown>;
  deviceCreatedAt: string;
}): SyncOperation {
  return {
    operationId: operation.operationId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    operation: operation.operation,
    baseRevision: operation.baseRevision,
    payload: operation.payload,
    deviceCreatedAt: operation.deviceCreatedAt,
  };
}

/** Local Notifications 要求正整数 ID；该映射跨重启保持稳定。 */
export function notificationIdFor(entityId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < entityId.length; index += 1) {
    hash ^= entityId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2_000_000_000 || 1;
}

export function conflictLabel(reason: string): string {
  if (reason === "MEMORY_MERGE_REQUIRED") return "记忆在其他设备被修改，需要选择版本";
  if (reason === "COMPLETED_MONOTONIC") return "服务器上的事项已完成，不能从旧设备重新打开";
  if (reason === "ENTITY_DELETED") return "服务器已删除该内容，需要选择是否重新创建";
  if (reason === "INVALID_PAYLOAD") return "本地内容格式与服务器不兼容";
  if (reason === "OPERATION_ID_REUSED") return "同步操作标识被重复用于不同内容，已安全停止";
  return "该内容在其他设备有更新";
}

export function canRetryLocalConflict(
  entityType: string,
  reason: string,
  serverDeleted = reason === "ENTITY_DELETED",
): boolean {
  if (reason === "COMPLETED_MONOTONIC" || reason === "INVALID_PAYLOAD") return false;
  if (
    serverDeleted &&
    ["ASSISTANT", "ASSISTANT_THREAD", "ASSISTANT_MESSAGE"].includes(entityType)
  ) {
    // 单实体换 UUID 会断开助理层级；本轮不提供会产生孤儿数据的伪恢复入口。
    return false;
  }
  return true;
}

export function isConflictServerDeleted(conflict: StoredSyncConflict): boolean {
  if (conflict.serverOperation === "DELETE") return true;
  if (conflict.reason === "ENTITY_DELETED") return true;
  if (conflict.serverRevision === 0 && Object.keys(conflict.serverPayload).length === 0)
    return true;
  return (
    typeof conflict.serverPayload.deletedAt === "string" ||
    conflict.serverPayload.status === "DELETED"
  );
}

export function inferConflictServerOperation(
  conflict: Pick<StoredSyncConflict, "reason" | "serverRevision" | "serverPayload">,
): "UPSERT" | "DELETE" {
  return isConflictServerDeleted({
    ...conflict,
    operationId: "",
    accountKey: "",
    entityType: "MEMORY",
    entityId: "",
    serverOperation: "UPSERT",
    localPayload: {},
    localOperation: "UPSERT",
    createdAt: "",
  })
    ? "DELETE"
    : "UPSERT";
}
