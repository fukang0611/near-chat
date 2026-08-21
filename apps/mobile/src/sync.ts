import type { SyncChange, SyncConflict } from "@near-chat/domain";
import type {
  EntityByType,
  MobileSyncState,
  StoredOutboxOperation,
  StoredSyncConflict,
  SyncProfile,
} from "./models";
import { cancelReminder } from "./notifications";
import {
  acknowledgeOutbox,
  clearSyncCursor,
  claimOutbox,
  deleteConflictIfCurrent,
  ensureInstallationId,
  getSyncCursor,
  listConflicts,
  listEntities,
  listOutbox,
  markOutboxFailed,
  nativeHttpRequest,
  reassignProfile,
  removeRemoteEntity,
  removeLocalEntity,
  removeLocalEntityInMutation,
  saveConflict,
  saveLocalEntity,
  saveRemoteEntity,
  settleRemoteSyncChange,
  secureGet,
  secureRemove,
  secureSet,
  setSyncCursor,
} from "./native";
import { applyRemoteDelete, applyRemoteUpsert } from "./remote-change";
import { cancelThenMutateReminder, reconcileCurrentReminder } from "./reminder-reconcile";
import { shouldRecoverPullCursor, SyncHttpError } from "./sync-errors";
import { ProfileTransitionCoordinator } from "./profile-transitions";
import { commitProfileJournal, recoverProfileJournal } from "./profile-journal";
import { resolveAccountMutationKey, runAccountMutation } from "./account-mutations";
import { consumeBootstrapPages, type BootstrapPage } from "./bootstrap-pagination";
import { consumePullPage, shouldRepeatBlockedPull } from "./pull-page";
import { applyRemoteSyncChange } from "./remote-sync-apply";
import {
  accountNamespace,
  asSyncOperation,
  canRetryLocalConflict,
  conflictBaseRevision,
  conflictRetryPlan,
  isConflictServerDeleted,
  inferConflictServerOperation,
  localNamespace,
  normalizeServerUrl,
  refreshConflictFromRemoteChange,
  splitSyncPushBatches,
} from "./sync-logic";

interface AuthUser {
  id: string;
  username: string;
}

interface PushResponse {
  applied: SyncChange[];
  conflicts: SyncConflict[];
  acknowledgedOperationIds?: string[];
}

interface PullResponse {
  changes: SyncChange[];
  cursor: string;
  hasMore: boolean;
}

const PROFILE_KEYS = [
  "active-account-key",
  "server-url",
  "server-token",
  "server-user-id",
  "server-username",
  "profile-generation",
] as const;
const profileTransitions = new ProfileTransitionCoordinator();
const PROFILE_TRANSITION_JOURNAL_KEY = "profile-transition-v1";
const accountSyncQueues = new Map<string, Promise<unknown>>();

function withAccountSyncLock<T>(accountKey: string, task: () => Promise<T>): Promise<T> {
  const previous = accountSyncQueues.get(accountKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  accountSyncQueues.set(accountKey, current);
  const cleanup = () => {
    if (accountSyncQueues.get(accountKey) === current) accountSyncQueues.delete(accountKey);
  };
  void current.then(cleanup, cleanup);
  return current;
}

function stableConflictValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConflictValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableConflictValue(child)]),
    );
  }
  return value;
}

function sameConflictAuthority(left: StoredSyncConflict, right: StoredSyncConflict): boolean {
  return (
    left.operationId === right.operationId &&
    left.reason === right.reason &&
    left.serverRevision === right.serverRevision &&
    left.serverOperation === right.serverOperation &&
    JSON.stringify(stableConflictValue(left.serverPayload)) ===
      JSON.stringify(stableConflictValue(right.serverPayload))
  );
}

async function currentConflictForDecision(
  expected: StoredSyncConflict,
): Promise<StoredSyncConflict> {
  const current = (await listConflicts(expected.accountKey)).find(
    (candidate) => candidate.operationId === expected.operationId,
  );
  if (!current) throw new Error("该同步冲突已被处理，请刷新后重试");
  if (!sameConflictAuthority(current, expected)) {
    throw new Error("服务器版本已更新，请刷新冲突后重新选择");
  }
  return current;
}

async function deleteConflictVersion(expected: StoredSyncConflict): Promise<void> {
  if (!(await deleteConflictIfCurrent(expected))) {
    throw new Error("服务器版本在处理期间已更新，冲突已保留，请重新选择");
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${normalizeServerUrl(baseUrl)}/api${path}`;
}

function responseData<T>(data: unknown): T {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as T;
    } catch {
      throw new Error("团队服务返回了无法解析的数据");
    }
  }
  return data as T;
}

function errorDetail(data: unknown): string | null {
  if (!data || typeof data !== "object")
    return typeof data === "string" ? data.slice(0, 200) : null;
  const record = data as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return null;
}

async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: { method?: "GET" | "POST"; token?: string; data?: unknown } = {},
): Promise<T> {
  const response = await nativeHttpRequest({
    url: endpoint(baseUrl, path),
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.data === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    data: options.data,
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = errorDetail(response.data);
    throw new SyncHttpError(
      response.status,
      detail ? `团队服务返回 ${response.status}：${detail}` : `团队服务返回 ${response.status}`,
      response.data,
    );
  }
  return responseData<T>(response.data);
}

function assertSyncActive(shouldContinue: () => boolean): void {
  if (!shouldContinue()) throw new Error("同步已取消");
}

async function persistProfile(profile: SyncProfile): Promise<void> {
  const generation = crypto.randomUUID();
  await Promise.all([
    secureSet("active-account-key", profile.accountKey),
    secureSet("server-url", profile.serverUrl),
    secureSet("server-token", profile.token),
    secureSet("server-user-id", profile.userId),
    secureSet("server-username", profile.username),
    secureSet("profile-generation", generation),
  ]);
}

const profileJournalEffects = {
  read: () => secureGet(PROFILE_TRANSITION_JOURNAL_KEY),
  write: (value: string) => secureSet(PROFILE_TRANSITION_JOURNAL_KEY, value),
  clear: () => secureRemove(PROFILE_TRANSITION_JOURNAL_KEY),
  reassign: reassignProfile,
  persist: persistProfile,
};

async function activateProfile(
  serverUrl: string,
  token: string,
  user: AuthUser,
  previousAccountKey?: string,
): Promise<SyncProfile> {
  const installationId = await ensureInstallationId();
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const accountKey = accountNamespace(normalizedServerUrl, user.id, installationId);
  const profile: SyncProfile = {
    accountKey,
    installationId,
    serverUrl: normalizedServerUrl,
    token,
    userId: user.id,
    username: user.username,
  };
  const fromAccountKey =
    previousAccountKey === localNamespace(installationId)
      ? resolveAccountMutationKey(previousAccountKey)
      : null;
  try {
    return await commitProfileJournal(profile, fromAccountKey, profileJournalEffects);
  } catch (error) {
    // 短暂的 Keystore 写失败先在当前进程内续做；持久失败时 journal 留给下次启动。
    try {
      const recovered = await recoverProfileJournal(profileJournalEffects);
      if (recovered) return recovered;
      throw error;
    } catch {
      throw error;
    }
  }
}

export async function loginToTeam(
  serverUrl: string,
  username: string,
  password: string,
  previousAccountKey?: string,
): Promise<SyncProfile> {
  const transition = profileTransitions.begin();
  const result = await apiRequest<{ token: string; user: AuthUser }>(serverUrl, "/auth/login", {
    method: "POST",
    data: { username: username.trim(), password },
  });
  return transition.commit(() =>
    activateProfile(serverUrl, result.token, result.user, previousAccountKey),
  );
}

export async function connectWithToken(
  serverUrl: string,
  token: string,
  previousAccountKey?: string,
): Promise<SyncProfile> {
  const transition = profileTransitions.begin();
  const result = await apiRequest<{ user: AuthUser }>(serverUrl, "/auth/me", {
    token: token.trim(),
  });
  return transition.commit(() =>
    activateProfile(serverUrl, token.trim(), result.user, previousAccountKey),
  );
}

export async function invalidateProfileTransitions(): Promise<void> {
  await profileTransitions.invalidateAndWait();
}

export async function loadStoredProfile(): Promise<SyncProfile | null> {
  await recoverProfileJournal(profileJournalEffects);
  const [accountKey, installationId, serverUrl, token, userId, username] = await Promise.all([
    secureGet("active-account-key"),
    ensureInstallationId(),
    secureGet("server-url"),
    secureGet("server-token"),
    secureGet("server-user-id"),
    secureGet("server-username"),
  ]);
  if (!accountKey || !serverUrl || !token || !userId || !username) return null;
  return { accountKey, installationId, serverUrl, token, userId, username };
}

export async function clearStoredProfile(): Promise<void> {
  await Promise.all([
    ...PROFILE_KEYS.map((key) => secureRemove(key)),
    secureRemove(PROFILE_TRANSITION_JOURNAL_KEY),
  ]);
}

export async function restoreStoredProfile(profile: SyncProfile): Promise<void> {
  await persistProfile(profile);
  await secureRemove(PROFILE_TRANSITION_JOURNAL_KEY);
}

type ApplyChangeResult = "APPLIED" | "DEFERRED" | "BLOCKED";

async function reconcileConflictsForChange(
  accountKey: string,
  change: SyncChange,
): Promise<"NONE" | "REFRESHED" | "BLOCKED"> {
  const conflicts = await listConflicts(accountKey);
  const matching = conflicts.filter(
    (conflict) =>
      conflict.entityType === change.entityType && conflict.entityId === change.entityId,
  );
  if (!matching.length) return "NONE";
  let blocked = false;
  for (const conflict of matching) {
    const refreshed = refreshConflictFromRemoteChange(conflict, change);
    if (!refreshed.cursorCanAdvance) blocked = true;
    if (refreshed.changed) await saveConflict(refreshed.conflict);
  }
  return blocked ? "BLOCKED" : "REFRESHED";
}

async function applyChange(
  accountKey: string,
  change: SyncChange,
  options: { ownApplied?: boolean; acknowledgedOperationIds?: readonly string[] } = {},
  shouldContinue: () => boolean = () => true,
): Promise<ApplyChangeResult> {
  assertSyncActive(shouldContinue);
  if (!options.ownApplied) {
    const conflictState = await reconcileConflictsForChange(accountKey, change);
    if (conflictState === "BLOCKED") return "BLOCKED";
    if (conflictState === "REFRESHED") return "DEFERRED";
  }
  const result = await applyRemoteSyncChange(change, {
    settle: (candidate) => {
      const settle = (effectiveAccountKey: string) =>
        settleRemoteSyncChange(
          effectiveAccountKey,
          candidate,
          options.acknowledgedOperationIds ?? [],
        );
      // 删除提醒必须保持 cancel-before-remove：cancel 失败或进程在事务前退出时，Room 行和旧 cursor
      // 仍在，启动恢复可重新枚举；事务提交时旧 alarm 已确定撤销。
      return candidate.entityType === "PERSONAL_REMINDER" && candidate.operation === "DELETE"
        ? cancelThenMutateReminder(accountKey, candidate.entityId, settle)
        : runAccountMutation(accountKey, settle);
    },
    reconcileReminder: (entityId) =>
      reconcileCurrentReminder(accountKey, entityId, shouldContinue).then(() => undefined),
  });
  assertSyncActive(shouldContinue);
  return result;
}

function entityKey(value: { entityType: string; entityId: string; operation?: string }): string {
  return `${value.entityType}\u0000${value.entityId}\u0000${value.operation ?? "UPSERT"}`;
}

async function pushBatch(
  profile: SyncProfile,
  deviceId: string,
  batch: StoredOutboxOperation[],
  shouldContinue: () => boolean,
): Promise<{
  pushed: number;
  conflicts: number;
}> {
  assertSyncActive(shouldContinue);
  const operationIds = batch.map((operation) => operation.operationId);
  let response: PushResponse;
  try {
    response = await apiRequest<PushResponse>(profile.serverUrl, "/sync/push", {
      method: "POST",
      token: profile.token,
      data: {
        deviceId,
        operations: batch.map(asSyncOperation),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步推送失败";
    await markOutboxFailed(operationIds, message);
    throw error;
  }
  assertSyncActive(shouldContinue);

  const conflictIds = new Set(response.conflicts.map((conflict) => conflict.operationId));
  const appliedKeys = new Set(response.applied.map(entityKey));
  const explicitlyAcknowledged = new Set(response.acknowledgedOperationIds ?? []);
  const acknowledged = batch
    .filter((operation) =>
      explicitlyAcknowledged.size
        ? explicitlyAcknowledged.has(operation.operationId) ||
          conflictIds.has(operation.operationId)
        : conflictIds.has(operation.operationId) || appliedKeys.has(entityKey(operation)),
    )
    .map((operation) => operation.operationId);

  for (const conflict of response.conflicts) {
    const operation = batch.find((candidate) => candidate.operationId === conflict.operationId);
    if (!operation) continue;
    const stored: StoredSyncConflict = {
      ...conflict,
      accountKey: profile.accountKey,
      serverOperation: inferConflictServerOperation(conflict),
      localPayload: operation.payload,
      localOperation: operation.operation,
      createdAt: new Date().toISOString(),
    };
    await saveConflict(stored);
  }
  for (const change of response.applied) {
    const acknowledgedForChange = batch
      .filter(
        (operation) =>
          acknowledged.includes(operation.operationId) &&
          entityKey(operation) === entityKey(change),
      )
      .map((operation) => operation.operationId);
    await applyChange(
      profile.accountKey,
      change,
      { ownApplied: true, acknowledgedOperationIds: acknowledgedForChange },
      shouldContinue,
    );
  }
  await acknowledgeOutbox(acknowledged);
  return { pushed: response.applied.length, conflicts: response.conflicts.length };
}

let deviceCache = new Map<string, string>();

async function registeredDeviceId(
  profile: SyncProfile,
  shouldContinue: () => boolean,
): Promise<string> {
  assertSyncActive(shouldContinue);
  const cached = deviceCache.get(profile.accountKey);
  if (cached) return cached;
  const registration = await apiRequest<{ device: { id: string } }>(
    profile.serverUrl,
    "/sync/devices/register",
    {
      method: "POST",
      token: profile.token,
      data: {
        installationId: profile.installationId,
        name: "NearChat Android",
        platform: "ANDROID",
        appVersion: "0.2.0",
      },
    },
  );
  assertSyncActive(shouldContinue);
  deviceCache.set(profile.accountKey, registration.device.id);
  return registration.device.id;
}

async function bootstrap(
  profile: SyncProfile,
  deviceId: string,
  shouldContinue: () => boolean,
): Promise<number> {
  return consumeBootstrapPages({
    fetchPage: (pageToken) =>
      apiRequest<BootstrapPage>(profile.serverUrl, "/sync/bootstrap", {
        method: "POST",
        token: profile.token,
        data: { deviceId, ...(pageToken ? { pageToken } : {}) },
      }),
    applyChange: (change) => applyChange(profile.accountKey, change, {}, shouldContinue),
    commitCursor: (cursor) => setSyncCursor(profile.accountKey, cursor),
    shouldRestartToken: (error) => error instanceof SyncHttpError && error.status === 400,
    shouldContinue,
  });
}

async function pullAll(
  profile: SyncProfile,
  deviceId: string,
  initialCursor: string,
  shouldContinue: () => boolean,
): Promise<{ pulled: number; blocked: boolean; blockedChanges: SyncChange[] }> {
  let cursor = initialCursor;
  let pulled = 0;
  for (let page = 0; page < 100; page += 1) {
    assertSyncActive(shouldContinue);
    const query = new URLSearchParams({ deviceId, cursor, limit: "500" });
    const result = await consumePullPage({
      fetchPage: () =>
        apiRequest<PullResponse>(profile.serverUrl, `/sync/pull?${query.toString()}`, {
          token: profile.token,
        }),
      applyChange: (change) => applyChange(profile.accountKey, change, {}, shouldContinue),
      commitCursor: (nextCursor) => setSyncCursor(profile.accountKey, nextCursor),
      shouldContinue,
    });
    const response = result.page;
    pulled += response.changes.length;
    // 仍可应用同页其他实体，但不能确认已跳过的 tombstone；下一次同步会从旧 cursor 重放。
    if (result.blocked) return { pulled, blocked: true, blockedChanges: result.blockedChanges };
    cursor = response.cursor;
    if (!response.hasMore) return { pulled, blocked: false, blockedChanges: [] };
  }
  throw new Error("同步变更过多，已安全停止；请再次同步继续拉取");
}

async function syncPersonalDataUnlocked(
  profile: SyncProfile,
  onState?: (state: MobileSyncState) => void,
  shouldContinue: () => boolean = () => true,
): Promise<MobileSyncState> {
  let pushed = 0;
  let conflictCount = 0;
  let pulled = 0;
  assertSyncActive(shouldContinue);
  onState?.({ phase: "SYNCING", message: "正在注册设备…", pushed, pulled, conflicts: 0 });
  const deviceId = await registeredDeviceId(profile, shouldContinue);
  let cursorRecovered = false;
  let settled = false;
  // pull HTTP 在途期间仍可能产生新 outbox；最多重排 20 轮，每轮都先 push，再从旧 cursor 重放。
  for (let syncRound = 0; syncRound < 20; syncRound += 1) {
    for (let batchIndex = 0; batchIndex < 100; batchIndex += 1) {
      assertSyncActive(shouldContinue);
      const batch = await claimOutbox(profile.accountKey);
      if (!batch.length) break;
      const byId = new Map(batch.map((operation) => [operation.operationId, operation]));
      const transferBatches = splitSyncPushBatches(deviceId, batch.map(asSyncOperation)).map(
        (operations) =>
          operations.map((operation) => {
            const stored = byId.get(operation.operationId);
            if (!stored) throw new Error("同步认领快照已损坏");
            return stored;
          }),
      );
      for (const transferBatch of transferBatches) {
        onState?.({
          phase: "SYNCING",
          message: `正在推送 ${transferBatch.length} 项本地变更…`,
          pushed,
          pulled,
          conflicts: conflictCount,
        });
        const result = await pushBatch(profile, deviceId, transferBatch, shouldContinue);
        pushed += result.pushed;
        conflictCount += result.conflicts;
        if (result.pushed + result.conflicts === 0) {
          throw new Error("服务端未确认同步操作，outbox 已保留供重试");
        }
      }
    }
    if ((await listOutbox(profile.accountKey, 1)).length) {
      throw new Error("本地变更超过单次同步上限，剩余 outbox 已保留；请再次同步");
    }

    let cursor = await getSyncCursor(profile.accountKey);
    if (cursor === null) {
      onState?.({
        phase: "SYNCING",
        message: "正在初始化设备数据…",
        pushed,
        pulled,
        conflicts: conflictCount,
      });
      pulled += await bootstrap(profile, deviceId, shouldContinue);
      cursor = await getSyncCursor(profile.accountKey);
      if (cursor === null) throw new Error("bootstrap 未返回完整末页游标");
    }
    onState?.({
      phase: "SYNCING",
      message: "正在拉取增量变更…",
      pushed,
      pulled,
      conflicts: conflictCount,
    });

    let pullResult: { pulled: number; blocked: boolean; blockedChanges: SyncChange[] };
    for (;;) {
      try {
        pullResult = await pullAll(profile, deviceId, cursor, shouldContinue);
        pulled += pullResult.pulled;
        break;
      } catch (error) {
        if (!shouldRecoverPullCursor(error, cursorRecovered)) throw error;
        cursorRecovered = true;
        assertSyncActive(shouldContinue);
        onState?.({
          phase: "SYNCING",
          message: "同步游标已失效，正在重新初始化设备数据…",
          pushed,
          pulled,
          conflicts: conflictCount,
        });
        await clearSyncCursor(profile.accountKey);
        pulled += await bootstrap(profile, deviceId, shouldContinue);
        cursor = await getSyncCursor(profile.accountKey);
        if (cursor === null) throw new Error("bootstrap 未返回完整末页游标");
      }
    }

    const pendingAfterPull = (await listOutbox(profile.accountKey, 1)).length > 0;
    if (pullResult.blocked) {
      const persistedConflicts = await listConflicts(profile.accountKey);
      // Worker 可能在 BLOCKED 后恰好 ACK 并清掉 outbox；没有对应持久冲突时必须从旧 cursor
      // 再拉一轮，不能把“未提交页游标”误报为 CONNECTED。
      if (shouldRepeatBlockedPull(pendingAfterPull, pullResult.blockedChanges, persistedConflicts))
        continue;
    } else if (pendingAfterPull) continue;
    // 对应冲突已持久化时保留旧 cursor，交给用户决策后重放。
    settled = true;
    break;
  }
  if (!settled) throw new Error("同步期间本地修改持续产生，outbox 与旧游标已保留；请再次同步");

  conflictCount = (await listConflicts(profile.accountKey)).length;
  const state: MobileSyncState = {
    phase: conflictCount ? "CONFLICT" : "CONNECTED",
    message: conflictCount
      ? `同步完成，有 ${conflictCount} 项冲突待处理`
      : `同步完成：推送 ${pushed} 项，拉取 ${pulled} 项`,
    pushed,
    pulled,
    conflicts: conflictCount,
  };
  onState?.(state);
  return state;
}

export async function syncPersonalData(
  profile: SyncProfile,
  onState?: (state: MobileSyncState) => void,
  shouldContinue: () => boolean = () => true,
): Promise<MobileSyncState> {
  return withAccountSyncLock(profile.accountKey, () =>
    syncPersonalDataUnlocked(profile, onState, shouldContinue),
  );
}

function assertConflictActive(shouldContinue: () => boolean): void {
  if (!shouldContinue()) throw new Error("账号已切换，冲突处理已取消");
}

export async function acceptServerConflict(
  conflict: StoredSyncConflict,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  return withAccountSyncLock(conflict.accountKey, async () => {
    conflict = await currentConflictForDecision(conflict);
    await acceptServerConflictUnlocked(conflict, shouldContinue);
  });
}

async function acceptServerConflictUnlocked(
  conflict: StoredSyncConflict,
  shouldContinue: () => boolean,
): Promise<void> {
  assertConflictActive(shouldContinue);
  if (conflict.reason === "MEMORY_MERGE_REQUIRED") {
    await resolveServerMemoryConflict(conflict, "DISMISSED");
    assertConflictActive(shouldContinue);
  }
  if (isConflictServerDeleted(conflict)) {
    await applyRemoteDelete(
      {
        operation: "DELETE",
        entityType: conflict.entityType,
        entityId: conflict.entityId,
      },
      {
        cancelReminder,
        removeReminder: (entityId) =>
          cancelThenMutateReminder(conflict.accountKey, entityId, (effectiveAccountKey) =>
            removeRemoteEntity(effectiveAccountKey, "PERSONAL_REMINDER", entityId),
          ),
        removeEntity: (entityType, entityId) =>
          removeRemoteEntity(conflict.accountKey, entityType, entityId),
      },
    );
    assertConflictActive(shouldContinue);
    await deleteConflictVersion(conflict);
    return;
  }
  const entity = {
    ...conflict.serverPayload,
    id: conflict.entityId,
    revision: conflict.serverRevision,
  } as EntityByType[typeof conflict.entityType];
  await applyRemoteUpsert(conflict.entityType, entity, {
    saveEntity: (value) => saveRemoteEntity(conflict.accountKey, conflict.entityType, value),
    scheduleReminder: (reminder) =>
      reconcileCurrentReminder(conflict.accountKey, reminder.id, shouldContinue),
    cancelReminder,
    shouldContinue,
  });
  assertConflictActive(shouldContinue);
  await deleteConflictVersion(conflict);
}

export async function retryLocalConflict(
  conflict: StoredSyncConflict,
  shouldContinue: () => boolean = () => true,
): Promise<string> {
  return withAccountSyncLock(conflict.accountKey, async () => {
    conflict = await currentConflictForDecision(conflict);
    return retryLocalConflictUnlocked(conflict, shouldContinue);
  });
}

async function retryLocalConflictUnlocked(
  conflict: StoredSyncConflict,
  shouldContinue: () => boolean,
): Promise<string> {
  assertConflictActive(shouldContinue);
  if (
    !canRetryLocalConflict(conflict.entityType, conflict.reason, isConflictServerDeleted(conflict))
  ) {
    throw new Error("该层级实体已被服务器删除，不能安全地只恢复单个本地节点");
  }
  const retryPlan = conflictRetryPlan(conflict);
  if (retryPlan.operation === "DELETE") {
    if (retryPlan.serverDeleted) {
      await applyRemoteDelete(
        {
          operation: "DELETE",
          entityType: conflict.entityType,
          entityId: conflict.entityId,
        },
        {
          cancelReminder,
          removeReminder: (entityId) =>
            cancelThenMutateReminder(conflict.accountKey, entityId, (effectiveAccountKey) =>
              removeRemoteEntity(effectiveAccountKey, "PERSONAL_REMINDER", entityId),
            ),
          removeEntity: (entityType, entityId) =>
            removeRemoteEntity(conflict.accountKey, entityType, entityId),
        },
      );
      assertConflictActive(shouldContinue);
      await deleteConflictVersion(conflict);
      return conflict.operationId;
    }
    const operationId =
      conflict.entityType === "PERSONAL_REMINDER"
        ? await cancelThenMutateReminder(
            conflict.accountKey,
            conflict.entityId,
            (effectiveAccountKey) =>
              removeLocalEntityInMutation(
                effectiveAccountKey,
                conflict.entityType,
                conflict.entityId,
                retryPlan.baseRevision,
              ),
          )
        : await removeLocalEntity(
            conflict.accountKey,
            conflict.entityType,
            conflict.entityId,
            retryPlan.baseRevision,
          );
    assertConflictActive(shouldContinue);
    await deleteConflictVersion(conflict);
    return operationId;
  }
  const entities = await listEntities(conflict.accountKey, conflict.entityType);
  const current = entities.find((entity) => entity.id === conflict.entityId);
  let entity = {
    ...(current ?? {}),
    ...conflict.localPayload,
    id: conflict.entityId,
    revision: conflict.serverRevision,
  } as EntityByType[typeof conflict.entityType];
  let baseRevision = conflictBaseRevision(conflict.serverRevision);
  if (isConflictServerDeleted(conflict) || conflict.reason === "APPEND_ONLY") {
    const replacementId = crypto.randomUUID();
    entity = {
      ...entity,
      id: replacementId,
      revision: 0,
      ...(Object.hasOwn(entity, "updatedAt") ? { updatedAt: new Date().toISOString() } : {}),
      ...(conflict.entityType === "ASSISTANT_MESSAGE"
        ? { createdAt: new Date().toISOString() }
        : {}),
    } as EntityByType[typeof conflict.entityType];
    if (conflict.entityType === "PERSONAL_REMINDER") {
      await cancelThenMutateReminder(
        conflict.accountKey,
        conflict.entityId,
        (effectiveAccountKey) =>
          removeRemoteEntity(effectiveAccountKey, conflict.entityType, conflict.entityId),
      );
    } else {
      await removeRemoteEntity(conflict.accountKey, conflict.entityType, conflict.entityId);
    }
    baseRevision = null;
  }
  const operationId = await saveLocalEntity(conflict.accountKey, conflict.entityType, entity, {
    baseRevision,
    forceNewOperation: true,
  });
  if (conflict.entityType === "PERSONAL_REMINDER") {
    assertConflictActive(shouldContinue);
    await reconcileCurrentReminder(conflict.accountKey, entity.id, shouldContinue);
  }
  assertConflictActive(shouldContinue);
  if (conflict.reason !== "MEMORY_MERGE_REQUIRED") await deleteConflictVersion(conflict);
  return operationId;
}

async function resolveServerMemoryConflict(
  conflict: StoredSyncConflict,
  status: "DISMISSED" | "RESOLVED",
): Promise<void> {
  const profile = await loadStoredProfile();
  if (!profile || profile.accountKey !== conflict.accountKey) {
    throw new Error("当前登录账号与该记忆冲突不匹配");
  }
  await apiRequest(
    profile.serverUrl,
    `/sync/memory-conflicts/${encodeURIComponent(conflict.operationId)}/resolve`,
    {
      method: "POST",
      token: profile.token,
      data: { status },
    },
  );
}

/** 本地重试只有在 operation 已被 ACK 且没有产生新冲突后，才关闭原记忆冲突。 */
export async function completeLocalMemoryConflictRetry(
  conflict: StoredSyncConflict,
  retryOperationId: string,
): Promise<void> {
  return withAccountSyncLock(conflict.accountKey, async () => {
    await completeLocalMemoryConflictRetryUnlocked(conflict, retryOperationId);
  });
}

async function completeLocalMemoryConflictRetryUnlocked(
  conflict: StoredSyncConflict,
  retryOperationId: string,
): Promise<void> {
  const [pending, conflicts] = await Promise.all([
    listOutbox(conflict.accountKey, 1000),
    listConflicts(conflict.accountKey),
  ]);
  if (pending.some((operation) => operation.operationId === retryOperationId)) {
    throw new Error("本地版本尚未被服务器确认，冲突已保留供重试");
  }
  if (
    conflicts.some(
      (candidate) =>
        candidate.operationId === retryOperationId ||
        (candidate.operationId !== conflict.operationId &&
          candidate.entityType === conflict.entityType &&
          candidate.entityId === conflict.entityId),
    )
  ) {
    throw new Error("本地版本仍与服务器冲突，请重新选择处理方式");
  }
  const current = conflicts.find((candidate) => candidate.operationId === conflict.operationId);
  if (!current) throw new Error("原记忆冲突已变化，请刷新后重新选择");
  const memory = (await listEntities(conflict.accountKey, "MEMORY")).find(
    (candidate) => candidate.id === conflict.entityId,
  );
  if (
    !memory ||
    current.serverOperation !== "UPSERT" ||
    current.serverRevision !== memory.revision
  ) {
    throw new Error("重试后服务器又产生了新版本，冲突已保留，请重新选择");
  }
  await resolveServerMemoryConflict(current, "RESOLVED");
  await deleteConflictVersion(current);
}

export function resetDeviceRegistrationCache(): void {
  deviceCache = new Map();
}
