import { isDeepStrictEqual } from "node:util";
import type { SyncChange, SyncEntityType } from "@near-chat/domain";
import type { PoolClient } from "pg";
import { ApiError } from "./http.js";

const GLOBAL_SYNC_STREAM_LOCK = "near-chat:sync-stream:global:v1";

function ownerSyncStreamLock(ownerId: string): string {
  return `near-chat:sync-stream:owner:${ownerId}`;
}

/**
 * 同一 owner 的 change 序号必须按事务提交顺序分配，否则 BIGSERIAL 的低序号可能晚提交，
 * 已推进 cursor 的设备将永远看不到它。所有调用方必须在任何业务行锁/写入之前获取此锁。
 *
 * 全局 shared 锁只用于和极少数动态跨 owner 写入（例如删除模型触发 FK SET NULL）协调；
 * owner 锁负责常规并发串行。多 owner 调用按 ownerId 排序，固定 global -> owner -> 业务行锁序。
 */
export async function lockOwnerSyncStreams(
  client: PoolClient,
  ownerIds: readonly string[],
): Promise<void> {
  const sortedOwnerIds = [...new Set(ownerIds)].sort();
  if (sortedOwnerIds.length === 0) return;
  await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`, [
    GLOBAL_SYNC_STREAM_LOCK,
  ]);
  for (const ownerId of sortedOwnerIds) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
      ownerSyncStreamLock(ownerId),
    ]);
  }
}

export async function lockOwnerSyncStream(client: PoolClient, ownerId: string): Promise<void> {
  await lockOwnerSyncStreams(client, [ownerId]);
}

/** 动态跨 owner 写入在读取受影响 owner 前独占全局锁，禁止遗漏并发新增的关联行。 */
export async function lockAllOwnerSyncStreams(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
    GLOBAL_SYNC_STREAM_LOCK,
  ]);
}

export interface SyncSnapshotRow {
  entity_type: SyncEntityType;
  entity_id: string;
  revision: number;
  payload: Record<string, unknown>;
  deleted_at: Date | null;
  updated_at: Date;
}

interface SyncChangeRow {
  sequence: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: "UPSERT" | "DELETE";
  revision: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export function publicSyncChange(row: SyncChangeRow): SyncChange {
  return {
    sequence: row.sequence,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    revision: row.revision,
    payload: row.payload ?? {},
    occurredAt: row.occurred_at.toISOString(),
  };
}

export async function loadSyncSnapshot(
  client: PoolClient,
  ownerId: string,
  entityType: SyncEntityType,
  entityId: string,
  lock = false,
): Promise<SyncSnapshotRow | null> {
  const result = await client.query<SyncSnapshotRow>(
    `SELECT entity_type, entity_id, revision, payload, deleted_at, updated_at
       FROM sync_entity_snapshots
      WHERE owner_id = $1 AND entity_type = $2 AND entity_id = $3${lock ? " FOR UPDATE" : ""}`,
    [ownerId, entityType, entityId],
  );
  return result.rows[0] ?? null;
}

export async function appendSyncChange(
  client: PoolClient,
  ownerId: string,
  entityType: SyncEntityType,
  entityId: string,
  operation: "UPSERT" | "DELETE",
  revision: number,
  payload: Record<string, unknown>,
): Promise<SyncChange> {
  const result = await client.query<SyncChangeRow>(
    `INSERT INTO sync_changes (owner_id, entity_type, entity_id, operation, revision, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING sequence::text, entity_type, entity_id, operation, revision, payload, occurred_at`,
    [ownerId, entityType, entityId, operation, revision, payload],
  );
  return publicSyncChange(result.rows[0]!);
}

/**
 * 在业务实体成功写入的同一事务中更新投影和增量流。
 * 生产调用方必须已在任何业务行锁前获取 owner/global stream 锁；这里禁止补拿晚锁。
 */
export async function recordSyncSnapshot(
  client: PoolClient,
  ownerId: string,
  entityType: SyncEntityType,
  entityId: string,
  revision: number,
  payload: Record<string, unknown>,
  deleted = false,
): Promise<SyncChange | null> {
  const current = await loadSyncSnapshot(client, ownerId, entityType, entityId, true);
  if (current) {
    if (current.revision > revision) {
      throw new ApiError(409, "同步投影版本不能回退");
    }
    if (current.revision === revision) {
      if (
        Boolean(current.deleted_at) === deleted &&
        isDeepStrictEqual(current.payload ?? {}, payload)
      ) {
        return null;
      }
      throw new ApiError(409, "同步投影版本冲突：同一 revision 内容不同");
    }
  }
  const persisted = await client.query(
    `INSERT INTO sync_entity_snapshots (owner_id, entity_type, entity_id, revision, payload, deleted_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN NOW() ELSE NULL END)
     ON CONFLICT (owner_id, entity_type, entity_id) DO UPDATE
       SET revision = EXCLUDED.revision, payload = EXCLUDED.payload,
           deleted_at = EXCLUDED.deleted_at, updated_at = NOW()
     WHERE sync_entity_snapshots.revision < EXCLUDED.revision
     RETURNING revision`,
    [ownerId, entityType, entityId, revision, payload, deleted],
  );
  if (!persisted.rowCount) {
    const raced = await loadSyncSnapshot(client, ownerId, entityType, entityId, true);
    if (
      raced?.revision === revision &&
      Boolean(raced.deleted_at) === deleted &&
      isDeepStrictEqual(raced.payload ?? {}, payload)
    ) {
      return null;
    }
    throw new ApiError(409, "同步投影在并发写入时版本冲突");
  }
  return appendSyncChange(
    client,
    ownerId,
    entityType,
    entityId,
    deleted ? "DELETE" : "UPSERT",
    revision,
    payload,
  );
}
