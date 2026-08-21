import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import type {
  AgentHttpRequest,
  AgentHttpResponse,
  AgentHttpTransport,
} from "@near-chat/agent-protocol";
import type { SyncChange, SyncEntityType } from "@near-chat/domain";
import type {
  EntityByType,
  MobileEntity,
  StoredOutboxOperation,
  StoredSyncConflict,
} from "./models";
import { migrateAccountMutations, runAccountMutation } from "./account-mutations";
import { settleBrowserRemoteChange } from "./browser-remote-settlement";
import { isVisiblePrivateMemory } from "./memory-visibility";
import { resolveBaseRevision, selectUniqueEntityOperations } from "./sync-logic";

interface SecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface OfflineStorePlugin {
  list(options: { accountKey: string; entityType: string }): Promise<{
    entries: Array<{ id: string; value: string }>;
  }>;
  save(options: {
    accountKey: string;
    entityType: string;
    id: string;
    value: string;
    queueSync: boolean;
    operationId?: string;
    baseRevision?: number | null;
    forceNewOperation?: boolean;
  }): Promise<{ operationId?: string }>;
  remove(options: {
    accountKey: string;
    entityType: string;
    id: string;
    queueSync: boolean;
    operationId?: string;
    baseRevision?: number | null;
  }): Promise<{ operationId?: string }>;
  search(options: {
    accountKey: string;
    query: string;
    entityTypes: string[];
    limit: number;
  }): Promise<{ entries: Array<{ id: string; entityType: string; value: string }> }>;
  listOutbox(options: { accountKey: string; limit: number }): Promise<{ operations: string[] }>;
  claimOutbox(options: { accountKey: string }): Promise<{ operations: string[] }>;
  markOutboxAttempt(options: { operationIds: string[] }): Promise<void>;
  markOutboxFailed(options: { operationIds: string[]; error: string }): Promise<void>;
  acknowledgeOutbox(options: { operationIds: string[] }): Promise<void>;
  settleRemoteChange(options: {
    accountKey: string;
    entityType: string;
    id: string;
    operation: "UPSERT" | "DELETE";
    revision: number;
    value?: string;
    acknowledgedOperationIds: string[];
  }): Promise<{ applied: boolean }>;
  listConflicts(options: { accountKey: string }): Promise<{ conflicts: string[] }>;
  saveConflict(options: { conflict: string }): Promise<void>;
  deleteConflict(options: { operationId: string }): Promise<void>;
  deleteConflictIfCurrent(options: {
    operationId: string;
    reason: string;
    serverRevision: number;
    serverOperation: string;
    serverPayload: string;
  }): Promise<{ deleted: boolean }>;
  getCursor(options: { accountKey: string }): Promise<{ cursor: string | null }>;
  setCursor(options: { accountKey: string; cursor: string }): Promise<void>;
  clearCursor(options: { accountKey: string }): Promise<void>;
  reassignProfile(options: { fromAccountKey: string; toAccountKey: string }): Promise<void>;
  scheduleBackgroundSync(options: { intervalMinutes: number }): Promise<void>;
  cancelBackgroundSync(): Promise<void>;
  consumeBackgroundSyncRequest(): Promise<{ requested: boolean }>;
  networkPolicy(): Promise<{ allowCleartext: boolean; buildType: string }>;
}

const nativeSecureStore = registerPlugin<SecureStorePlugin>("SecureStore");
const nativeOfflineStore = registerPlugin<OfflineStorePlugin>("OfflineStore");
const storageKey = (namespace: string, key: string) => `near-chat.mobile.${namespace}.${key}`;

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function entityStorageKey(accountKey: string, entityType: string): string {
  return storageKey("entities", `${accountKey}.${entityType}`);
}

const outboxStorageKey = () => storageKey("sync", "outbox");
const conflictStorageKey = () => storageKey("sync", "conflicts");

export async function secureGet(key: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) return (await nativeSecureStore.get({ key })).value;
  return localStorage.getItem(storageKey("secure-fallback", key));
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return nativeSecureStore.set({ key, value });
  localStorage.setItem(storageKey("secure-fallback", key), value);
}

export async function secureRemove(key: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return nativeSecureStore.remove({ key });
  localStorage.removeItem(storageKey("secure-fallback", key));
}

export async function ensureInstallationId(): Promise<string> {
  const current = await secureGet("installation-id");
  if (current) return current;
  const created = crypto.randomUUID();
  await secureSet("installation-id", created);
  return created;
}

export async function listEntities<T extends SyncEntityType>(
  accountKey: string,
  entityType: T,
): Promise<EntityByType[T][]> {
  let entities: EntityByType[T][];
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.list({ accountKey, entityType });
    entities = result.entries.map((entry) => JSON.parse(entry.value) as EntityByType[T]);
  } else {
    entities = readJson<EntityByType[T][]>(entityStorageKey(accountKey, entityType), []);
  }
  return entityType === "MEMORY"
    ? entities.filter((entity) => isVisiblePrivateMemory(entity))
    : entities;
}

function saveBrowserEntity<T extends MobileEntity>(
  accountKey: string,
  entityType: SyncEntityType,
  entity: T,
): void {
  const key = entityStorageKey(accountKey, entityType);
  const values = readJson<T[]>(key, []);
  writeJson(key, [...values.filter((candidate) => candidate.id !== entity.id), entity]);
}

function queueBrowserOperation(
  accountKey: string,
  entityType: SyncEntityType,
  entityId: string,
  operation: "UPSERT" | "DELETE",
  payload: Record<string, unknown>,
  baseRevision: number | null,
  forceNewOperation: boolean,
): string {
  const operations = readJson<StoredOutboxOperation[]>(outboxStorageKey(), []);
  const existing = !forceNewOperation
    ? operations.find(
        (candidate) =>
          candidate.accountKey === accountKey &&
          candidate.entityType === entityType &&
          candidate.entityId === entityId &&
          candidate.operation === operation &&
          candidate.attemptCount === 0,
      )
    : undefined;
  if (existing) {
    existing.payload = payload;
    existing.deviceCreatedAt = new Date().toISOString();
    writeJson(outboxStorageKey(), operations);
    return existing.operationId;
  }
  const operationId = crypto.randomUUID();
  operations.push({
    operationId,
    accountKey,
    entityType,
    entityId,
    operation,
    baseRevision,
    payload,
    deviceCreatedAt: new Date().toISOString(),
    attemptCount: 0,
    lastError: null,
  });
  writeJson(outboxStorageKey(), operations);
  return operationId;
}

export async function saveLocalEntity<T extends SyncEntityType>(
  accountKey: string,
  entityType: T,
  entity: EntityByType[T],
  options: { baseRevision?: number | null; forceNewOperation?: boolean } = {},
): Promise<string> {
  return runAccountMutation(accountKey, async (effectiveAccountKey) => {
    const baseRevision = resolveBaseRevision(entity.revision, options);
    const operationId = crypto.randomUUID();
    if (Capacitor.isNativePlatform()) {
      const result = await nativeOfflineStore.save({
        accountKey: effectiveAccountKey,
        entityType,
        id: entity.id,
        value: JSON.stringify(entity),
        queueSync: true,
        operationId,
        baseRevision,
        forceNewOperation: options.forceNewOperation ?? false,
      });
      return result.operationId ?? operationId;
    }
    saveBrowserEntity(effectiveAccountKey, entityType, entity);
    return queueBrowserOperation(
      effectiveAccountKey,
      entityType,
      entity.id,
      "UPSERT",
      entity as unknown as Record<string, unknown>,
      baseRevision,
      options.forceNewOperation ?? false,
    );
  });
}

export async function saveRemoteEntity<T extends SyncEntityType>(
  accountKey: string,
  entityType: T,
  entity: EntityByType[T],
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await nativeOfflineStore.save({
      accountKey,
      entityType,
      id: entity.id,
      value: JSON.stringify(entity),
      queueSync: false,
    });
    return;
  }
  saveBrowserEntity(accountKey, entityType, entity);
}

export async function removeLocalEntity(
  accountKey: string,
  entityType: SyncEntityType,
  id: string,
  baseRevision: number | null,
): Promise<string> {
  return runAccountMutation(accountKey, (effectiveAccountKey) =>
    removeLocalEntityInMutation(effectiveAccountKey, entityType, id, baseRevision),
  );
}

/** 仅供已经持有 runAccountMutation 生命周期屏障的复合操作使用。 */
export async function removeLocalEntityInMutation(
  effectiveAccountKey: string,
  entityType: SyncEntityType,
  id: string,
  baseRevision: number | null,
): Promise<string> {
  const operationId = crypto.randomUUID();
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.remove({
      accountKey: effectiveAccountKey,
      entityType,
      id,
      queueSync: true,
      operationId,
      baseRevision,
    });
    return result.operationId ?? operationId;
  }
  const key = entityStorageKey(effectiveAccountKey, entityType);
  const values = readJson<Array<{ id: string }>>(key, []);
  writeJson(
    key,
    values.filter((item) => item.id !== id),
  );
  return queueBrowserOperation(
    effectiveAccountKey,
    entityType,
    id,
    "DELETE",
    {},
    baseRevision,
    true,
  );
}

export async function removeRemoteEntity(
  accountKey: string,
  entityType: SyncEntityType,
  id: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await nativeOfflineStore.remove({ accountKey, entityType, id, queueSync: false });
    return;
  }
  const key = entityStorageKey(accountKey, entityType);
  const values = readJson<Array<{ id: string }>>(key, []);
  writeJson(
    key,
    values.filter((item) => item.id !== id),
  );
}

/**
 * push ACK 与权威实体写入在 Room 中同事务完成；pull 则以空 ACK 列表复用同一边界。
 * 返回 false 表示同实体已有更新 outbox，本地实体必须保留且 pull 页游标不得推进。
 */
export async function settleRemoteSyncChange(
  accountKey: string,
  change: SyncChange,
  acknowledgedOperationIds: readonly string[] = [],
): Promise<boolean> {
  const entity =
    change.operation === "UPSERT"
      ? ({
          ...(change.payload as Record<string, unknown>),
          id: change.entityId,
          revision: change.revision,
        } as MobileEntity)
      : null;
  if (Capacitor.isNativePlatform()) {
    return (
      await nativeOfflineStore.settleRemoteChange({
        accountKey,
        entityType: change.entityType,
        id: change.entityId,
        operation: change.operation,
        revision: change.revision,
        ...(entity ? { value: JSON.stringify(entity) } : {}),
        acknowledgedOperationIds: [...acknowledgedOperationIds],
      })
    ).applied;
  }
  return settleBrowserRemoteChange(accountKey, change, acknowledgedOperationIds, {
    readOutbox: () => readJson<StoredOutboxOperation[]>(outboxStorageKey(), []),
    writeOutbox: (operations) => writeJson(outboxStorageKey(), operations),
    saveEntity: (value) => saveBrowserEntity(accountKey, change.entityType, value),
    removeEntity: () => {
      const key = entityStorageKey(accountKey, change.entityType);
      const values = readJson<Array<{ id: string }>>(key, []);
      writeJson(
        key,
        values.filter((item) => item.id !== change.entityId),
      );
    },
  });
}

export async function searchEntities<T extends SyncEntityType>(
  accountKey: string,
  query: string,
  entityTypes: readonly T[],
  limit = 50,
): Promise<Array<{ entityType: T; entity: EntityByType[T] }>> {
  const normalized = query.trim();
  if (!normalized) {
    const combined = await Promise.all(
      entityTypes.map(async (entityType) =>
        (await listEntities(accountKey, entityType)).map((entity) => ({ entityType, entity })),
      ),
    );
    return combined.flat().slice(0, limit);
  }
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.search({
      accountKey,
      query: normalized,
      entityTypes: [...entityTypes],
      limit,
    });
    return result.entries
      .map((entry) => ({
        entityType: entry.entityType as T,
        entity: JSON.parse(entry.value) as EntityByType[T],
      }))
      .filter(({ entityType, entity }) => entityType !== "MEMORY" || isVisiblePrivateMemory(entity))
      .slice(0, limit);
  }
  const needle = normalized.toLocaleLowerCase();
  const entries = await searchEntities(accountKey, "", entityTypes, Number.MAX_SAFE_INTEGER);
  return entries
    .filter(({ entity }) => JSON.stringify(entity).toLocaleLowerCase().includes(needle))
    .slice(0, limit);
}

export async function listOutbox(
  accountKey: string,
  limit = 500,
): Promise<StoredOutboxOperation[]> {
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.listOutbox({ accountKey, limit });
    return result.operations.map((operation) => JSON.parse(operation) as StoredOutboxOperation);
  }
  return readJson<StoredOutboxOperation[]>(outboxStorageKey(), [])
    .filter((operation) => operation.accountKey === accountKey)
    .slice(0, limit);
}

export async function claimOutbox(accountKey: string): Promise<StoredOutboxOperation[]> {
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.claimOutbox({ accountKey });
    return result.operations.map((operation) => JSON.parse(operation) as StoredOutboxOperation);
  }
  // 浏览器 localStorage 的同步读改写在单个 JS task 内原子完成。
  const operations = readJson<StoredOutboxOperation[]>(outboxStorageKey(), []);
  const selected = selectUniqueEntityOperations(
    operations.filter((operation) => operation.accountKey === accountKey),
    100,
  );
  const ids = new Set(selected.map((operation) => operation.operationId));
  writeJson(
    outboxStorageKey(),
    operations.map((operation) =>
      ids.has(operation.operationId)
        ? { ...operation, attemptCount: operation.attemptCount + 1, lastError: null }
        : operation,
    ),
  );
  return selected;
}

function updateBrowserOutbox(
  operationIds: readonly string[],
  update: (operation: StoredOutboxOperation) => StoredOutboxOperation | null,
): void {
  const ids = new Set(operationIds);
  const next = readJson<StoredOutboxOperation[]>(outboxStorageKey(), []).flatMap((operation) => {
    if (!ids.has(operation.operationId)) return [operation];
    const changed = update(operation);
    return changed ? [changed] : [];
  });
  writeJson(outboxStorageKey(), next);
}

export async function markOutboxAttempt(operationIds: string[]): Promise<void> {
  if (!operationIds.length) return;
  if (Capacitor.isNativePlatform()) return nativeOfflineStore.markOutboxAttempt({ operationIds });
  updateBrowserOutbox(operationIds, (operation) => ({
    ...operation,
    attemptCount: operation.attemptCount + 1,
    lastError: null,
  }));
}

export async function markOutboxFailed(operationIds: string[], error: string): Promise<void> {
  if (!operationIds.length) return;
  if (Capacitor.isNativePlatform())
    return nativeOfflineStore.markOutboxFailed({ operationIds, error: error.slice(0, 1000) });
  updateBrowserOutbox(operationIds, (operation) => ({
    ...operation,
    lastError: error.slice(0, 1000),
  }));
}

export async function acknowledgeOutbox(operationIds: string[]): Promise<void> {
  if (!operationIds.length) return;
  if (Capacitor.isNativePlatform()) return nativeOfflineStore.acknowledgeOutbox({ operationIds });
  updateBrowserOutbox(operationIds, () => null);
}

export async function listConflicts(accountKey: string): Promise<StoredSyncConflict[]> {
  if (Capacitor.isNativePlatform()) {
    const result = await nativeOfflineStore.listConflicts({ accountKey });
    return result.conflicts.map((conflict) => JSON.parse(conflict) as StoredSyncConflict);
  }
  return readJson<StoredSyncConflict[]>(conflictStorageKey(), []).filter(
    (conflict) => conflict.accountKey === accountKey,
  );
}

export async function saveConflict(conflict: StoredSyncConflict): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await nativeOfflineStore.saveConflict({ conflict: JSON.stringify(conflict) });
    return;
  }
  const conflicts = readJson<StoredSyncConflict[]>(conflictStorageKey(), []);
  writeJson(conflictStorageKey(), [
    ...conflicts.filter((candidate) => candidate.operationId !== conflict.operationId),
    conflict,
  ]);
}

export async function deleteConflict(operationId: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return nativeOfflineStore.deleteConflict({ operationId });
  const conflicts = readJson<StoredSyncConflict[]>(conflictStorageKey(), []);
  writeJson(
    conflictStorageKey(),
    conflicts.filter((candidate) => candidate.operationId !== operationId),
  );
}

/** 按权威版本 CAS 删除；后台 Worker 若刚刷新冲突，旧 UI 不能把新记录一并删掉。 */
export async function deleteConflictIfCurrent(expected: StoredSyncConflict): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    return (
      await nativeOfflineStore.deleteConflictIfCurrent({
        operationId: expected.operationId,
        reason: expected.reason,
        serverRevision: expected.serverRevision,
        serverOperation: expected.serverOperation,
        serverPayload: JSON.stringify(expected.serverPayload),
      })
    ).deleted;
  }
  const conflicts = readJson<StoredSyncConflict[]>(conflictStorageKey(), []);
  const current = conflicts.find((candidate) => candidate.operationId === expected.operationId);
  if (
    !current ||
    current.reason !== expected.reason ||
    current.serverRevision !== expected.serverRevision ||
    current.serverOperation !== expected.serverOperation ||
    JSON.stringify(current.serverPayload) !== JSON.stringify(expected.serverPayload)
  )
    return false;
  writeJson(
    conflictStorageKey(),
    conflicts.filter((candidate) => candidate.operationId !== expected.operationId),
  );
  return true;
}

export async function getSyncCursor(accountKey: string): Promise<string | null> {
  if (Capacitor.isNativePlatform())
    return (await nativeOfflineStore.getCursor({ accountKey })).cursor;
  return localStorage.getItem(storageKey("cursor", accountKey));
}

export async function setSyncCursor(accountKey: string, cursor: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return nativeOfflineStore.setCursor({ accountKey, cursor });
  localStorage.setItem(storageKey("cursor", accountKey), cursor);
}

export async function clearSyncCursor(accountKey: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return nativeOfflineStore.clearCursor({ accountKey });
  localStorage.removeItem(storageKey("cursor", accountKey));
}

export async function reassignProfile(fromAccountKey: string, toAccountKey: string): Promise<void> {
  if (fromAccountKey === toAccountKey) return;
  return migrateAccountMutations(
    fromAccountKey,
    toAccountKey,
    async (effectiveFrom, effectiveTo) => {
      if (effectiveFrom === effectiveTo) return;
      if (Capacitor.isNativePlatform()) {
        await nativeOfflineStore.reassignProfile({
          fromAccountKey: effectiveFrom,
          toAccountKey: effectiveTo,
        });
        return;
      }
      const entityTypes: SyncEntityType[] = [
        "MEMORY",
        "PERSONAL_TASK",
        "PERSONAL_REMINDER",
        "PERSONAL_RECORD",
        "ASSISTANT",
        "ASSISTANT_THREAD",
        "ASSISTANT_MESSAGE",
      ];
      for (const entityType of entityTypes) {
        const fromKey = entityStorageKey(effectiveFrom, entityType);
        const toKey = entityStorageKey(effectiveTo, entityType);
        const from = readJson<Array<{ id: string }>>(fromKey, []);
        const to = readJson<Array<{ id: string }>>(toKey, []);
        const ids = new Set(to.map((entity) => entity.id));
        writeJson(toKey, [...to, ...from.filter((entity) => !ids.has(entity.id))]);
        localStorage.removeItem(fromKey);
      }
      const outbox = readJson<StoredOutboxOperation[]>(outboxStorageKey(), []);
      const migratedOutbox = new Map<string, StoredOutboxOperation>();
      // 目标账号已有同 operationId 时以目标为准；重放 journal 不会制造重复操作。
      for (const operation of outbox.filter((item) => item.accountKey === effectiveTo)) {
        migratedOutbox.set(operation.operationId, operation);
      }
      for (const operation of outbox) {
        const migrated =
          operation.accountKey === effectiveFrom
            ? { ...operation, accountKey: effectiveTo }
            : operation;
        if (!migratedOutbox.has(migrated.operationId)) {
          migratedOutbox.set(migrated.operationId, migrated);
        }
      }
      writeJson(outboxStorageKey(), [...migratedOutbox.values()]);

      const conflicts = readJson<StoredSyncConflict[]>(conflictStorageKey(), []);
      const migratedConflicts = new Map<string, StoredSyncConflict>();
      for (const conflict of conflicts.filter((item) => item.accountKey === effectiveTo)) {
        migratedConflicts.set(conflict.operationId, conflict);
      }
      for (const conflict of conflicts) {
        const migrated =
          conflict.accountKey === effectiveFrom
            ? { ...conflict, accountKey: effectiveTo }
            : conflict;
        if (!migratedConflicts.has(migrated.operationId)) {
          migratedConflicts.set(migrated.operationId, migrated);
        }
      }
      writeJson(conflictStorageKey(), [...migratedConflicts.values()]);
    },
  );
}

let backgroundSyncTail: Promise<void> = Promise.resolve();

function serializeBackgroundSync(operation: () => Promise<void>): Promise<void> {
  const current = backgroundSyncTail.catch(() => undefined).then(operation);
  backgroundSyncTail = current;
  return current;
}

export async function scheduleBackgroundSync(intervalMinutes = 15): Promise<void> {
  await serializeBackgroundSync(async () => {
    if (Capacitor.isNativePlatform()) {
      await nativeOfflineStore.scheduleBackgroundSync({
        intervalMinutes: Math.max(15, intervalMinutes),
      });
    }
  });
}

export async function cancelBackgroundSync(): Promise<void> {
  await serializeBackgroundSync(async () => {
    if (Capacitor.isNativePlatform()) await nativeOfflineStore.cancelBackgroundSync();
  });
}

export async function consumeBackgroundSyncRequest(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  return (await nativeOfflineStore.consumeBackgroundSyncRequest()).requested;
}

let cachedNetworkPolicy: { allowCleartext: boolean; buildType: string } | null = null;

export async function networkPolicy(): Promise<{ allowCleartext: boolean; buildType: string }> {
  if (!Capacitor.isNativePlatform()) {
    return {
      allowCleartext: ["localhost", "127.0.0.1", "::1"].includes(location.hostname),
      buildType: "web",
    };
  }
  cachedNetworkPolicy ??= await nativeOfflineStore.networkPolicy();
  return cachedNetworkPolicy;
}

export interface NativeHttpOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  data?: unknown;
  timeoutMs?: number;
}

export async function nativeHttpRequest(options: NativeHttpOptions): Promise<AgentHttpResponse> {
  const url = new URL(options.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("网络请求只支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("网络地址不能包含用户名或密码");
  }
  if (url.protocol === "http:") {
    const policy = await networkPolicy();
    if (!policy.allowCleartext) {
      throw new Error("正式版只允许 HTTPS；团队凭据和模型 API Key 不会通过明文 HTTP 发送");
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: url.toString(),
      method: options.method ?? "GET",
      headers: options.headers,
      data: options.data,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      disableRedirects: true,
    });
    return { status: response.status, data: response.data };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 错误由调用方按状态码处理。
      }
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export const nativeAgentTransport: AgentHttpTransport = (request: AgentHttpRequest) =>
  nativeHttpRequest({
    url: request.url,
    method: request.method,
    headers: request.headers,
    data: request.body,
    timeoutMs: request.timeoutMs,
  });
