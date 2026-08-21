import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  isSyncEntityType,
  resolveSyncOperation,
  type MemorySyncConflictResolution,
  type SyncAppliedChange,
  type SyncChange,
  type SyncConflict,
  type SyncEntityType,
  type SyncOperation,
  type SyncPushResult,
} from "@near-chat/domain";
import type { PoolClient } from "pg";
import { ZodError } from "zod";
import { deleteMemoryVector, replaceMemoryVector } from "./ai/ai-runtime.js";
import { closeAiAssistantBrowserSessions } from "./assistant/assistant-browser-service.js";
import { config } from "./config.js";
import { transaction } from "./database.js";
import { ApiError } from "./http.js";
import {
  applyAuthoritativeSyncOperation,
  parseSyncEntityPayload,
  projectSyncEntity,
  refreshOwnerSyncProjectionPage,
  type AuthoritativeSyncState,
  type SyncProjectionBackfillCursor,
} from "./sync-entity-adapter.js";
import { lockOwnerSyncStream, type SyncSnapshotRow } from "./sync-projection.js";

interface DeviceRow {
  id: string;
  installation_id: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen_at: Date;
}

interface ChangeRow {
  sequence: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: "UPSERT" | "DELETE";
  revision: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

interface ChangeMetadataRow {
  sequence: string;
  entity_type: SyncEntityType;
  entity_id: string;
  payload_bytes: number;
}

interface SnapshotMetadataRow {
  entity_type: SyncEntityType;
  entity_id: string;
  payload_bytes: number;
}

interface StoredOperationRow {
  device_id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: "UPSERT" | "DELETE";
  base_revision: number | null;
  request_fingerprint: string | null;
  outcome: { applied?: SyncAppliedChange; conflict?: SyncConflict };
}

const ENTITY_TYPES = new Set<SyncEntityType>([
  "MEMORY",
  "PERSONAL_TASK",
  "PERSONAL_REMINDER",
  "PERSONAL_RECORD",
  "ASSISTANT",
  "ASSISTANT_THREAD",
  "ASSISTANT_MESSAGE",
]);

export const SYNC_RESPONSE_BYTE_BUDGET_BYTES = 768 * 1024;
export const SYNC_PROJECTION_BACKFILL_PAGE_SIZE = 100;
export const SYNC_BOOTSTRAP_SNAPSHOT_PAGE_SIZE = 200;
const BOOTSTRAP_PAGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_PAGE_TOKEN_VERSION = 1;
const RESPONSE_FIXED_BYTE_RESERVE = 2048;
const CHANGE_FIXED_BYTE_ESTIMATE = 512;

export interface BootstrapPageTokenState {
  version: 1;
  ownerId: string;
  deviceId: string;
  phase: "BACKFILL" | "SNAPSHOT";
  afterEntityType: SyncEntityType;
  afterEntityId: string;
  watermark: string;
  expiresAt: number;
}

export interface SyncBootstrapPage {
  phase: "BACKFILL" | "SNAPSHOT";
  changes: SyncChange[];
  /** 首次 bootstrap 请求冻结的 change 水位，后续页面保持不变。 */
  watermark: string;
  /** 仅完整最后一页返回并提交；中间页必须为 null。 */
  cursor: string | null;
  hasMore: boolean;
  nextPageToken: string | null;
}

export interface SyncPullPage {
  changes: SyncChange[];
  cursor: string;
  hasMore: boolean;
}

interface BootstrapSyncOptions {
  pageToken?: string;
  backfillPageSize?: number;
  snapshotPageSize?: number;
  responseByteBudget?: number;
  tokenSecret?: string;
  nowMs?: number;
}

function invalidBootstrapPageToken(): never {
  throw new ApiError(400, "bootstrap 分页令牌无效或已过期，请重新开始");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function signBootstrapPageToken(
  state: BootstrapPageTokenState,
  secret = config.jwtSecret,
): string {
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyBootstrapPageToken(
  token: string,
  ownerId: string,
  deviceId: string,
  secret = config.jwtSecret,
  nowMs = Date.now(),
): BootstrapPageTokenState {
  if (token.length > 4096) invalidBootstrapPageToken();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) invalidBootstrapPageToken();
  const [encoded, signatureText] = parts as [string, string];
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureText, "base64url");
  } catch {
    invalidBootstrapPageToken();
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    invalidBootstrapPageToken();
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    invalidBootstrapPageToken();
  }
  if (!candidate || typeof candidate !== "object") invalidBootstrapPageToken();
  const state = candidate as Partial<BootstrapPageTokenState>;
  if (
    state.version !== BOOTSTRAP_PAGE_TOKEN_VERSION ||
    state.ownerId !== ownerId ||
    state.deviceId !== deviceId ||
    (state.phase !== "BACKFILL" && state.phase !== "SNAPSHOT") ||
    typeof state.afterEntityType !== "string" ||
    !isSyncEntityType(state.afterEntityType) ||
    !ENTITY_TYPES.has(state.afterEntityType) ||
    !isUuid(state.afterEntityId) ||
    typeof state.watermark !== "string" ||
    !/^(0|[1-9]\d*)$/.test(state.watermark) ||
    typeof state.expiresAt !== "number" ||
    !Number.isSafeInteger(state.expiresAt) ||
    state.expiresAt <= nowMs
  ) {
    invalidBootstrapPageToken();
  }
  return state as BootstrapPageTokenState;
}

export function jsonUtf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ApiError(500, "同步响应无法序列化为 JSON");
  return Buffer.byteLength(serialized, "utf8");
}

function invalidPageSize(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 500) {
    throw new ApiError(500, `${label}分页上限无效`);
  }
  return value;
}

function invalidResponseByteBudget(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new ApiError(500, "同步响应字节预算无效");
  return value;
}

export function selectSyncPayloadMetadataWithinBudget<
  T extends { entity_type: SyncEntityType; entity_id: string; payload_bytes: number },
>(rows: readonly T[], byteBudget: number): T[] {
  const selected: T[] = [];
  let estimatedBytes = RESPONSE_FIXED_BYTE_RESERVE;
  for (const row of rows) {
    const payloadBytes = Number(row.payload_bytes);
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
      throw new ApiError(500, "同步实体 payload 字节统计无效");
    }
    if (selected.length === 0) {
      if (payloadBytes > byteBudget) {
        oversizedSyncEntity(
          { entityType: row.entity_type, entityId: row.entity_id },
          payloadBytes,
          byteBudget,
          "payload",
        );
      }
      selected.push(row);
      estimatedBytes += payloadBytes + CHANGE_FIXED_BYTE_ESTIMATE;
      if (estimatedBytes > byteBudget) break;
      continue;
    }
    if (estimatedBytes + payloadBytes + CHANGE_FIXED_BYTE_ESTIMATE > byteBudget) break;
    selected.push(row);
    estimatedBytes += payloadBytes + CHANGE_FIXED_BYTE_ESTIMATE;
  }
  return selected;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  return value;
}

export function syncOperationFingerprint(operation: SyncOperation): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableJson({
          entityType: operation.entityType,
          entityId: operation.entityId,
          operation: operation.operation,
          baseRevision: operation.baseRevision,
          payload: operation.payload,
          deviceCreatedAt: operation.deviceCreatedAt,
        }),
      ),
    )
    .digest("hex");
}

function publicDevice(row: DeviceRow) {
  return {
    id: row.id,
    installationId: row.installation_id,
    name: row.name,
    platform: row.platform,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

function publicChange(row: ChangeRow): SyncChange {
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

function asSyncType(value: string): SyncEntityType {
  if (!isSyncEntityType(value) || !ENTITY_TYPES.has(value))
    throw new ApiError(400, "不支持的同步实体类型");
  return value;
}

async function requireDevice(
  client: PoolClient,
  ownerId: string,
  deviceId: string,
): Promise<DeviceRow> {
  const result = await client.query<DeviceRow>(
    `SELECT id,installation_id,name,platform,app_version,last_seen_at
       FROM sync_devices
      WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL
      FOR UPDATE`,
    [deviceId, ownerId],
  );
  const device = result.rows[0];
  if (!device) throw new ApiError(404, "同步设备不存在或已撤销");
  await client.query(
    `UPDATE sync_devices SET last_seen_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2`,
    [deviceId, ownerId],
  );
  return device;
}

export async function registerSyncDeviceWithClient(
  client: PoolClient,
  ownerId: string,
  input: { installationId: string; name: string; platform: string; appVersion: string },
) {
  const result = await client.query<DeviceRow>(
    `INSERT INTO sync_devices
       (id,owner_id,installation_id,name,platform,app_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_id,installation_id) DO UPDATE
       SET name=EXCLUDED.name,platform=EXCLUDED.platform,app_version=EXCLUDED.app_version,
           last_seen_at=NOW(),updated_at=NOW(),revoked_at=NULL
     RETURNING id,installation_id,name,platform,app_version,last_seen_at`,
    [randomUUID(), ownerId, input.installationId, input.name, input.platform, input.appVersion],
  );
  const device = result.rows[0]!;
  await client.query(
    `INSERT INTO sync_cursors (device_id,owner_id) VALUES ($1,$2)
     ON CONFLICT (device_id) DO UPDATE
       SET owner_id=EXCLUDED.owner_id,updated_at=NOW()`,
    [device.id, ownerId],
  );
  return publicDevice(device);
}

export async function registerSyncDevice(
  ownerId: string,
  input: { installationId: string; name: string; platform: string; appVersion: string },
) {
  return transaction((client) => registerSyncDeviceWithClient(client, ownerId, input));
}

function conflict(
  operation: SyncOperation,
  reason: SyncConflict["reason"],
  current: AuthoritativeSyncState | null,
): SyncConflict {
  return {
    operationId: operation.operationId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    reason,
    serverRevision: current?.revision ?? 0,
    serverPayload: current?.payload ?? {},
  };
}

async function appliedFromCurrent(
  client: PoolClient,
  ownerId: string,
  operation: SyncOperation,
  current: AuthoritativeSyncState,
): Promise<SyncAppliedChange> {
  const existing = await client.query<ChangeRow>(
    `SELECT sequence::text,entity_type,entity_id,operation,revision,payload,occurred_at
       FROM sync_changes
      WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND revision=$4
      ORDER BY sequence DESC
      LIMIT 1`,
    [ownerId, operation.entityType, operation.entityId, current.revision],
  );
  const change = existing.rows[0];
  if (!change) throw new ApiError(409, "同步实体缺少可确认的增量记录，请重新 bootstrap");
  return {
    operationId: operation.operationId,
    ...publicChange(change),
  };
}

async function saveOperationOutcome(
  client: PoolClient,
  ownerId: string,
  deviceId: string,
  operation: SyncOperation,
  fingerprint: string,
  outcome: StoredOperationRow["outcome"],
): Promise<void> {
  await client.query(
    `INSERT INTO sync_operations
       (operation_id,device_id,owner_id,entity_type,entity_id,operation,base_revision,
        request_fingerprint,outcome,device_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      operation.operationId,
      deviceId,
      ownerId,
      operation.entityType,
      operation.entityId,
      operation.operation,
      operation.baseRevision,
      fingerprint,
      JSON.stringify(outcome),
      operation.deviceCreatedAt,
    ],
  );
}

async function recordMemoryMergeConflict(
  client: PoolClient,
  ownerId: string,
  operation: SyncOperation,
  serverRevision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_sync_conflicts
       (id,owner_id,memory_id,operation_id,base_revision,server_revision,incoming_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (owner_id,operation_id) DO NOTHING`,
    [
      randomUUID(),
      ownerId,
      operation.entityId,
      operation.operationId,
      operation.baseRevision,
      serverRevision,
      operation.payload,
    ],
  );
}

function sameAppendOnlyMessage(
  operation: SyncOperation,
  current: AuthoritativeSyncState | null,
): boolean {
  if (
    operation.entityType !== "ASSISTANT_MESSAGE" ||
    operation.operation !== "UPSERT" ||
    !current ||
    current.deleted
  )
    return false;
  try {
    const incoming = parseSyncEntityPayload("ASSISTANT_MESSAGE", operation.payload);
    const authoritative = parseSyncEntityPayload("ASSISTANT_MESSAGE", current.payload);
    return (
      JSON.stringify(stableJson({ ...incoming, sources: [] })) ===
      JSON.stringify(stableJson({ ...authoritative, sources: [] }))
    );
  } catch {
    return false;
  }
}

function isPostgresInputConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["22001", "22P02", "23502", "23503", "23505", "23514"].includes(String(error.code));
}

export async function pushSyncOperationsWithClient(
  client: PoolClient,
  ownerId: string,
  deviceId: string,
  operations: SyncOperation[],
): Promise<SyncPushResult> {
  await lockOwnerSyncStream(client, ownerId);
  await requireDevice(client, ownerId, deviceId);
  const applied: SyncAppliedChange[] = [];
  const conflicts: SyncConflict[] = [];
  const acknowledgedOperationIds: string[] = [];

  for (const rawOperation of operations) {
    const operation = { ...rawOperation, entityType: asSyncType(rawOperation.entityType) };
    const fingerprint = syncOperationFingerprint(operation);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `sync-operation:${ownerId}:${operation.operationId}`,
    ]);
    const duplicate = await client.query<StoredOperationRow>(
      `SELECT device_id,entity_type,entity_id,operation,base_revision,request_fingerprint,outcome
         FROM sync_operations WHERE owner_id=$1 AND operation_id=$2`,
      [ownerId, operation.operationId],
    );
    const stored = duplicate.rows[0];
    if (stored) {
      if (stored.request_fingerprint && stored.request_fingerprint !== fingerprint) {
        // operationId 复用仍必须返回目标实体的当前权威版本；固定 r0/空 payload 会让客户端
        // 把一个真实存在、但没有后续 change 的实体误判为“服务器已删除”。
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `sync-entity:${ownerId}:${operation.entityType}:${operation.entityId}`,
        ]);
        const current = await projectSyncEntity(
          client,
          ownerId,
          operation.entityType,
          operation.entityId,
        );
        conflicts.push(conflict(operation, "OPERATION_ID_REUSED", current));
        continue;
      }
      if (stored.outcome.applied) {
        applied.push(stored.outcome.applied);
        acknowledgedOperationIds.push(operation.operationId);
      } else if (stored.outcome.conflict) {
        conflicts.push(stored.outcome.conflict);
      }
      continue;
    }

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `sync-entity:${ownerId}:${operation.entityType}:${operation.entityId}`,
    ]);
    let current = await projectSyncEntity(
      client,
      ownerId,
      operation.entityType,
      operation.entityId,
    );

    if (operation.operation === "UPSERT") {
      try {
        parseSyncEntityPayload(operation.entityType, operation.payload);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        const invalid = conflict(operation, "INVALID_PAYLOAD", current);
        conflicts.push(invalid);
        await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
          conflict: invalid,
        });
        continue;
      }
    }

    if (sameAppendOnlyMessage(operation, current)) {
      const existing = await appliedFromCurrent(client, ownerId, operation, current!);
      applied.push(existing);
      acknowledgedOperationIds.push(operation.operationId);
      await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
        applied: existing,
      });
      continue;
    }
    if (
      operation.entityType === "ASSISTANT_MESSAGE" &&
      operation.operation === "UPSERT" &&
      current
    ) {
      const appendOnly = conflict(operation, "APPEND_ONLY", current);
      conflicts.push(appendOnly);
      await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
        conflict: appendOnly,
      });
      continue;
    }

    const resolution = resolveSyncOperation(operation, current);
    if (resolution.kind === "CONFLICT") {
      const rejected = conflict(operation, resolution.reason, current);
      conflicts.push(rejected);
      if (resolution.reason === "MEMORY_MERGE_REQUIRED") {
        await recordMemoryMergeConflict(client, ownerId, operation, resolution.serverRevision);
      }
      await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
        conflict: rejected,
      });
      continue;
    }

    let change: SyncChange;
    await client.query("SAVEPOINT sync_apply_operation");
    try {
      change = await applyAuthoritativeSyncOperation(
        client,
        ownerId,
        operation,
        resolution.revision,
      );
      await client.query("RELEASE SAVEPOINT sync_apply_operation");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT sync_apply_operation");
      await client.query("RELEASE SAVEPOINT sync_apply_operation");
      const expectedApiError = error instanceof ApiError && [400, 403, 409].includes(error.status);
      if (!expectedApiError && !isPostgresInputConflict(error)) throw error;
      current = await projectSyncEntity(client, ownerId, operation.entityType, operation.entityId);
      const stale = error instanceof ApiError && error.status === 409 && current !== null;
      const reason = stale
        ? operation.entityType === "MEMORY"
          ? "MEMORY_MERGE_REQUIRED"
          : "STALE_REVISION"
        : "INVALID_PAYLOAD";
      const rejected = conflict(operation, reason, current);
      conflicts.push(rejected);
      if (reason === "MEMORY_MERGE_REQUIRED") {
        await recordMemoryMergeConflict(
          client,
          ownerId,
          operation,
          current?.revision ?? resolution.revision,
        );
      }
      await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
        conflict: rejected,
      });
      continue;
    }
    const accepted: SyncAppliedChange = { ...change, operationId: operation.operationId };
    applied.push(accepted);
    acknowledgedOperationIds.push(operation.operationId);
    await saveOperationOutcome(client, ownerId, deviceId, operation, fingerprint, {
      applied: accepted,
    });
  }
  return { applied, conflicts, acknowledgedOperationIds };
}

function refreshMemoryVectors(ownerId: string, result: SyncPushResult): void {
  for (const applied of result.applied) {
    if (applied.entityType !== "MEMORY") continue;
    if (applied.operation === "DELETE") {
      void deleteMemoryVector(applied.entityId).catch((error) =>
        console.warn("Failed to delete synchronized memory vector:", error),
      );
      continue;
    }
    const title = typeof applied.payload.title === "string" ? applied.payload.title : "";
    const content = typeof applied.payload.content === "string" ? applied.payload.content : "";
    const tier = applied.payload.tier === "SHORT_TERM" ? "SHORT_TERM" : "LONG_TERM";
    void replaceMemoryVector({
      id: applied.entityId,
      ownerId,
      tier,
      text: `${title}\n${content}`,
    }).catch((error) => console.warn("Failed to index synchronized memory:", error));
  }
}

function closeDeletedAssistantSessions(ownerId: string, result: SyncPushResult): void {
  for (const applied of result.applied) {
    if (applied.entityType !== "ASSISTANT" || applied.operation !== "DELETE") continue;
    void closeAiAssistantBrowserSessions(ownerId, applied.entityId).catch((error) =>
      console.warn("Failed to close synchronized assistant browser sessions:", error),
    );
  }
}

export async function pushSyncOperations(
  ownerId: string,
  deviceId: string,
  operations: SyncOperation[],
) {
  const result = await transaction((client) =>
    pushSyncOperationsWithClient(client, ownerId, deviceId, operations),
  );
  refreshMemoryVectors(ownerId, result);
  closeDeletedAssistantSessions(ownerId, result);
  return result;
}

function oversizedSyncEntity(
  change: Pick<SyncChange, "entityType" | "entityId">,
  responseBytes: number,
  byteBudget: number,
  measured = "最终 JSON 响应",
): never {
  throw new ApiError(
    413,
    `同步实体 ${change.entityType}/${change.entityId} 单条 ${measured} 为 ${responseBytes} 字节，超过 ${byteBudget} 字节预算，请缩短正文或联系管理员`,
  );
}

export function paginatePullChangesByByteBudget(
  candidates: readonly SyncChange[],
  after: string,
  limit: number,
  byteBudget = SYNC_RESPONSE_BYTE_BUDGET_BYTES,
  moreAvailableAfterCandidates = false,
): SyncPullPage {
  const maximumItems = invalidPageSize(limit, "同步 pull");
  const maximumBytes = invalidResponseByteBudget(byteBudget);
  if (candidates.length === 0) return { changes: [], cursor: after, hasMore: false };
  const available = candidates.slice(0, maximumItems);
  const buildPage = (count: number): SyncPullPage => ({
    changes: available.slice(0, count),
    cursor: available[count - 1]!.sequence,
    hasMore: candidates.length > count || moreAvailableAfterCandidates || count < available.length,
  });
  const fullPage = buildPage(available.length);
  if (jsonUtf8ByteLength(fullPage) <= maximumBytes) return fullPage;

  let low = 1;
  let high = available.length - 1;
  let best: SyncPullPage | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const proposed = buildPage(middle);
    if (jsonUtf8ByteLength(proposed) <= maximumBytes) {
      best = proposed;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best) return best;
  const one = buildPage(1);
  oversizedSyncEntity(available[0]!, jsonUtf8ByteLength(one), maximumBytes);
}

export async function pullSyncChangesWithClient(
  client: PoolClient,
  ownerId: string,
  deviceId: string,
  after: bigint,
  limit: number,
  responseByteBudget = SYNC_RESPONSE_BYTE_BUDGET_BYTES,
): Promise<SyncPullPage> {
  const pageLimit = invalidPageSize(limit, "同步 pull");
  await lockOwnerSyncStream(client, ownerId);
  await requireDevice(client, ownerId, deviceId);
  const maximum = await client.query<{ sequence: string }>(
    `SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM sync_changes WHERE owner_id=$1`,
    [ownerId],
  );
  const maximumSequence = BigInt(maximum.rows[0]!.sequence);
  if (after > maximumSequence)
    throw new ApiError(409, "同步游标超出当前账号范围，请重新 bootstrap");
  const metadata = await client.query<ChangeMetadataRow>(
    `SELECT sequence::text,entity_type,entity_id,octet_length(payload::text) AS payload_bytes
       FROM sync_changes
      WHERE owner_id=$1 AND sequence>$2
      ORDER BY sequence
      LIMIT $3`,
    [ownerId, after.toString(), pageLimit + 1],
  );
  const selectedMetadata = selectSyncPayloadMetadataWithinBudget(metadata.rows, responseByteBudget);
  const result = selectedMetadata.length
    ? await client.query<ChangeRow>(
        `SELECT sequence::text,entity_type,entity_id,operation,revision,payload,occurred_at
           FROM sync_changes
          WHERE owner_id=$1 AND sequence=ANY($2::bigint[])
          ORDER BY sequence`,
        [ownerId, selectedMetadata.map((row) => row.sequence)],
      )
    : { rows: [] as ChangeRow[] };
  if (result.rows.length !== selectedMetadata.length) {
    throw new ApiError(409, "同步增量在分页读取期间发生变化，请重试 pull");
  }
  const page = paginatePullChangesByByteBudget(
    result.rows.map(publicChange),
    after.toString(),
    pageLimit,
    responseByteBudget,
    metadata.rows.length > selectedMetadata.length,
  );
  await client.query(
    `UPDATE sync_cursors
        SET last_sequence=GREATEST(last_sequence,$3),updated_at=NOW()
      WHERE device_id=$1 AND owner_id=$2`,
    [deviceId, ownerId, page.cursor],
  );
  return page;
}

export async function pullSyncChanges(
  ownerId: string,
  deviceId: string,
  after: bigint,
  limit: number,
): Promise<SyncPullPage> {
  return transaction((client) =>
    pullSyncChangesWithClient(client, ownerId, deviceId, after, limit),
  );
}

interface BootstrapSnapshotPaginationOptions {
  ownerId: string;
  deviceId: string;
  watermark: string;
  expiresAt: number;
  tokenSecret: string;
  pageSize: number;
  responseByteBudget: number;
  moreAvailableAfterCandidates?: boolean;
}

export function paginateBootstrapSnapshotsByByteBudget(
  candidates: readonly SyncChange[],
  options: BootstrapSnapshotPaginationOptions,
): SyncBootstrapPage {
  const pageSize = invalidPageSize(options.pageSize, "同步 bootstrap snapshot");
  const responseByteBudget = invalidResponseByteBudget(options.responseByteBudget);
  if (candidates.length === 0) {
    return {
      phase: "SNAPSHOT",
      changes: [],
      watermark: options.watermark,
      cursor: options.watermark,
      hasMore: false,
      nextPageToken: null,
    };
  }
  const available = candidates.slice(0, pageSize);
  const buildPage = (count: number): SyncBootstrapPage => {
    const changes = available.slice(0, count);
    const last = changes.at(-1)!;
    const hasMore =
      candidates.length > count ||
      Boolean(options.moreAvailableAfterCandidates) ||
      count < available.length;
    return {
      phase: "SNAPSHOT",
      changes,
      watermark: options.watermark,
      cursor: hasMore ? null : options.watermark,
      hasMore,
      nextPageToken: hasMore
        ? signBootstrapPageToken(
            {
              version: BOOTSTRAP_PAGE_TOKEN_VERSION,
              ownerId: options.ownerId,
              deviceId: options.deviceId,
              phase: "SNAPSHOT",
              afterEntityType: last.entityType,
              afterEntityId: last.entityId,
              watermark: options.watermark,
              expiresAt: options.expiresAt,
            },
            options.tokenSecret,
          )
        : null,
    };
  };
  const fullPage = buildPage(available.length);
  if (jsonUtf8ByteLength(fullPage) <= responseByteBudget) return fullPage;

  let low = 1;
  let high = available.length - 1;
  let best: SyncBootstrapPage | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const proposed = buildPage(middle);
    if (jsonUtf8ByteLength(proposed) <= responseByteBudget) {
      best = proposed;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best) return best;
  const one = buildPage(1);
  oversizedSyncEntity(available[0]!, jsonUtf8ByteLength(one), responseByteBudget);
}

export async function bootstrapSyncWithClient(
  client: PoolClient,
  ownerId: string,
  deviceId: string,
  options: BootstrapSyncOptions = {},
): Promise<SyncBootstrapPage> {
  const backfillPageSize = invalidPageSize(
    options.backfillPageSize ?? SYNC_PROJECTION_BACKFILL_PAGE_SIZE,
    "同步 projection backfill",
  );
  const snapshotPageSize = invalidPageSize(
    options.snapshotPageSize ?? SYNC_BOOTSTRAP_SNAPSHOT_PAGE_SIZE,
    "同步 bootstrap snapshot",
  );
  const responseByteBudget = invalidResponseByteBudget(
    options.responseByteBudget ?? SYNC_RESPONSE_BYTE_BUDGET_BYTES,
  );
  const tokenSecret = options.tokenSecret ?? config.jwtSecret;
  const nowMs = options.nowMs ?? Date.now();
  const continuation = options.pageToken
    ? verifyBootstrapPageToken(options.pageToken, ownerId, deviceId, tokenSecret, nowMs)
    : null;

  await lockOwnerSyncStream(client, ownerId);
  await requireDevice(client, ownerId, deviceId);
  let watermark = continuation?.watermark;
  if (!watermark) {
    const maximum = await client.query<{ sequence: string }>(
      `SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM sync_changes WHERE owner_id=$1`,
      [ownerId],
    );
    watermark = maximum.rows[0]!.sequence;
  }
  const expiresAt = continuation?.expiresAt ?? nowMs + BOOTSTRAP_PAGE_TOKEN_TTL_MS;

  if (!continuation || continuation.phase === "BACKFILL") {
    const after: SyncProjectionBackfillCursor | null = continuation
      ? {
          entityType: continuation.afterEntityType,
          entityId: continuation.afterEntityId,
        }
      : null;
    const backfill = await refreshOwnerSyncProjectionPage(client, ownerId, after, backfillPageSize);
    if (backfill.hasMore) {
      if (!backfill.nextCursor) throw new ApiError(500, "同步投影分页未返回续传游标");
      const nextPageToken = signBootstrapPageToken(
        {
          version: BOOTSTRAP_PAGE_TOKEN_VERSION,
          ownerId,
          deviceId,
          phase: "BACKFILL",
          afterEntityType: backfill.nextCursor.entityType,
          afterEntityId: backfill.nextCursor.entityId,
          watermark,
          expiresAt,
        },
        tokenSecret,
      );
      const page: SyncBootstrapPage = {
        phase: "BACKFILL",
        changes: [],
        watermark,
        cursor: null,
        hasMore: true,
        nextPageToken,
      };
      if (jsonUtf8ByteLength(page) > responseByteBudget) {
        throw new ApiError(500, "bootstrap 分页元数据超过同步响应字节预算");
      }
      return page;
    }
  }

  const snapshotAfter = continuation?.phase === "SNAPSHOT" ? continuation : null;
  const snapshotMetadata = await client.query<SnapshotMetadataRow>(
    `SELECT entity_type,entity_id,octet_length(payload::text) AS payload_bytes
       FROM sync_entity_snapshots
      WHERE owner_id=$1
        AND (
          $2::text IS NULL
          OR entity_type > $2::text
          OR (entity_type=$2 AND entity_id>$3::uuid)
        )
      ORDER BY entity_type,entity_id
      LIMIT $4`,
    [
      ownerId,
      snapshotAfter?.afterEntityType ?? null,
      snapshotAfter?.afterEntityId ?? null,
      snapshotPageSize + 1,
    ],
  );
  const selectedSnapshotMetadata = selectSyncPayloadMetadataWithinBudget(
    snapshotMetadata.rows,
    responseByteBudget,
  );
  const snapshots = selectedSnapshotMetadata.length
    ? await client.query<SyncSnapshotRow>(
        `SELECT snapshot.entity_type,snapshot.entity_id,snapshot.revision,snapshot.payload,
                snapshot.deleted_at,snapshot.updated_at
           FROM sync_entity_snapshots snapshot
           JOIN unnest($2::text[],$3::uuid[]) selected(entity_type,entity_id)
             ON selected.entity_type=snapshot.entity_type
            AND selected.entity_id=snapshot.entity_id
          WHERE snapshot.owner_id=$1
          ORDER BY snapshot.entity_type,snapshot.entity_id`,
        [
          ownerId,
          selectedSnapshotMetadata.map((row) => row.entity_type),
          selectedSnapshotMetadata.map((row) => row.entity_id),
        ],
      )
    : { rows: [] as SyncSnapshotRow[] };
  if (snapshots.rows.length !== selectedSnapshotMetadata.length) {
    throw new ApiError(409, "同步快照在分页读取期间发生变化，请重新 bootstrap");
  }
  const candidates: SyncChange[] = snapshots.rows.map((row) => ({
    sequence: "0",
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.deleted_at ? ("DELETE" as const) : ("UPSERT" as const),
    revision: row.revision,
    payload: row.payload ?? {},
    occurredAt: row.updated_at.toISOString(),
  }));
  const page = paginateBootstrapSnapshotsByByteBudget(candidates, {
    ownerId,
    deviceId,
    watermark,
    expiresAt,
    tokenSecret,
    pageSize: snapshotPageSize,
    responseByteBudget,
    moreAvailableAfterCandidates: snapshotMetadata.rows.length > selectedSnapshotMetadata.length,
  });
  if (page.hasMore) return page;

  await client.query(
    `UPDATE sync_cursors
        SET last_sequence=GREATEST(last_sequence,$3),updated_at=NOW()
      WHERE device_id=$1 AND owner_id=$2`,
    [deviceId, ownerId, watermark],
  );
  return page;
}

export async function bootstrapSync(ownerId: string, deviceId: string, pageToken?: string) {
  return transaction(async (client) => {
    // 必须是 BEGIN 后第一条语句；每页 keyset 与该页内投影来自一致快照。
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return bootstrapSyncWithClient(client, ownerId, deviceId, { pageToken });
  });
}

export async function resolveMemorySyncConflictWithClient(
  client: PoolClient,
  ownerId: string,
  operationId: string,
  status: MemorySyncConflictResolution["status"],
): Promise<MemorySyncConflictResolution> {
  const updated = await client.query<{
    operation_id: string;
    memory_id: string;
    status: MemorySyncConflictResolution["status"];
    resolved_at: Date;
  }>(
    `UPDATE memory_sync_conflicts
        SET status=$3,resolved_at=NOW()
      WHERE owner_id=$1 AND operation_id=$2 AND status='PENDING'
      RETURNING operation_id,memory_id,status,resolved_at`,
    [ownerId, operationId, status],
  );
  let row = updated.rows[0];
  if (!row) {
    const existing = await client.query<{
      operation_id: string;
      memory_id: string;
      status: "PENDING" | MemorySyncConflictResolution["status"];
      resolved_at: Date | null;
    }>(
      `SELECT operation_id,memory_id,status,resolved_at
         FROM memory_sync_conflicts
        WHERE owner_id=$1 AND operation_id=$2`,
      [ownerId, operationId],
    );
    const current = existing.rows[0];
    if (!current) throw new ApiError(404, "记忆同步冲突不存在");
    if (current.status !== status || !current.resolved_at) {
      throw new ApiError(409, "记忆同步冲突已按其他方式处理");
    }
    row = {
      operation_id: current.operation_id,
      memory_id: current.memory_id,
      status: current.status,
      resolved_at: current.resolved_at,
    };
  }
  return {
    operationId: row.operation_id,
    memoryId: row.memory_id,
    status: row.status,
    resolvedAt: row.resolved_at.toISOString(),
  };
}

export async function resolveMemorySyncConflict(
  ownerId: string,
  operationId: string,
  status: MemorySyncConflictResolution["status"],
) {
  return transaction((client) =>
    resolveMemorySyncConflictWithClient(client, ownerId, operationId, status),
  );
}

/**
 * 供记忆/助理业务服务在自身事务内发布真实业务行，不允许直接构造泛型 JSON 快照。
 * 调用方必须已在业务行锁前获取 owner/global stream 锁，避免 BIGSERIAL 与提交顺序倒置。
 */
export async function projectBusinessEntityForSync(
  client: PoolClient,
  ownerId: string,
  entityType: SyncEntityType,
  entityId: string,
) {
  return projectSyncEntity(client, ownerId, entityType, entityId);
}

export async function latestSyncCursor(ownerId: string): Promise<string> {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const result = await client.query<{ sequence: string }>(
      `SELECT COALESCE(MAX(sequence),0)::text AS sequence FROM sync_changes WHERE owner_id=$1`,
      [ownerId],
    );
    return result.rows[0]!.sequence;
  });
}
