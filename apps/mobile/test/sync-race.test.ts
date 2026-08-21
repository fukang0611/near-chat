import assert from "node:assert/strict";
import test from "node:test";
import type { SyncChange } from "@near-chat/domain";
import { settleBrowserRemoteChange } from "../src/browser-remote-settlement.ts";
import type { PersonalReminder, StoredOutboxOperation } from "../src/models.ts";
import { consumePullPage, shouldRepeatBlockedPull } from "../src/pull-page.ts";
import { applyRemoteSyncChange } from "../src/remote-sync-apply.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function reminder(title: string, revision: number, scheduledAt: string): PersonalReminder {
  return {
    id: "reminder-a",
    title,
    note: "",
    scheduledAt,
    completedAt: null,
    notifiedAt: null,
    revision,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
  };
}

function operation(
  operationId: string,
  payload: PersonalReminder,
  attemptCount: number,
): StoredOutboxOperation {
  return {
    operationId,
    accountKey: "account-a",
    entityType: "PERSONAL_REMINDER",
    entityId: payload.id,
    operation: "UPSERT",
    baseRevision: payload.revision || null,
    payload: payload as unknown as Record<string, unknown>,
    deviceCreatedAt: "2026-08-21T00:01:00.000Z",
    attemptCount,
    lastError: null,
  };
}

function appliedReminder(value: PersonalReminder): SyncChange {
  return {
    sequence: "41",
    entityType: "PERSONAL_REMINDER",
    entityId: value.id,
    operation: "UPSERT",
    revision: value.revision,
    payload: value as unknown as Record<string, unknown>,
    occurredAt: "2026-08-21T00:02:00.000Z",
  };
}

test("push 在途时再次编辑 reminder：旧 ACK 原子移除但不回退实体和通知", async () => {
  const firstLocal = reminder("第一次编辑", 3, "2026-08-22T01:00:00.000Z");
  const newerLocal = reminder("请求期间的新编辑", 3, "2026-08-22T03:00:00.000Z");
  const authoritative = reminder("第一次编辑", 4, "2026-08-22T01:00:00.000Z");
  const response = deferred<SyncChange>();
  const state = {
    entity: firstLocal,
    outbox: [operation("old-operation", firstLocal, 1)],
  };
  const notificationEvents: string[] = [];

  const applying = response.promise.then((change) =>
    applyRemoteSyncChange(change, {
      settle: async (candidate) =>
        settleBrowserRemoteChange("account-a", candidate, ["old-operation"], {
          readOutbox: () => state.outbox,
          writeOutbox: (outbox) => {
            state.outbox = outbox;
          },
          saveEntity: (entity) => {
            state.entity = entity as PersonalReminder;
          },
          removeEntity: () => {
            throw new Error("本用例不应删除 reminder");
          },
        }),
      reconcileReminder: async () => {
        notificationEvents.push(`${state.entity.title}@${state.entity.scheduledAt}`);
      },
    }),
  );

  // 模拟 push HTTP 尚未返回时，UI 已经完成第二次 Room + outbox 写入。
  state.entity = newerLocal;
  state.outbox.push(operation("new-operation", newerLocal, 0));
  response.resolve(appliedReminder(authoritative));

  assert.equal(await applying, "BLOCKED");
  assert.deepEqual(state.entity, newerLocal);
  assert.deepEqual(notificationEvents, ["请求期间的新编辑@2026-08-22T03:00:00.000Z"]);
  assert.deepEqual(
    state.outbox.map(({ operationId, baseRevision }) => ({ operationId, baseRevision })),
    [{ operationId: "new-operation", baseRevision: 4 }],
  );
});

test("pull 在途时编辑 reminder：保留本地实体和通知且整页 cursor 不推进", async () => {
  const beforePull = reminder("拉取前", 3, "2026-08-22T01:00:00.000Z");
  const newerLocal = reminder("拉取期间的新编辑", 3, "2026-08-22T04:00:00.000Z");
  const remote = reminder("另一设备编辑", 4, "2026-08-22T02:00:00.000Z");
  const response = deferred<{ changes: SyncChange[]; cursor: string; hasMore: boolean }>();
  const state = { entity: beforePull, outbox: [] as StoredOutboxOperation[] };
  const committedCursors: string[] = [];
  const notificationEvents: string[] = [];

  const pulling = consumePullPage({
    fetchPage: () => response.promise,
    applyChange: (change) =>
      applyRemoteSyncChange(change, {
        settle: async (candidate) =>
          settleBrowserRemoteChange("account-a", candidate, [], {
            readOutbox: () => state.outbox,
            writeOutbox: (outbox) => {
              state.outbox = outbox;
            },
            saveEntity: (entity) => {
              state.entity = entity as PersonalReminder;
            },
            removeEntity: () => {
              throw new Error("本用例不应删除 reminder");
            },
          }),
        reconcileReminder: async () => {
          notificationEvents.push(`${state.entity.title}@${state.entity.scheduledAt}`);
        },
      }),
    commitCursor: async (cursor) => {
      committedCursors.push(cursor);
    },
    shouldContinue: () => true,
  });

  // fetch 已发出但响应未到；此时本地修改必须赢得实体与通知的当前视图。
  await Promise.resolve();
  state.entity = newerLocal;
  state.outbox.push(operation("during-pull", newerLocal, 0));
  response.resolve({ changes: [appliedReminder(remote)], cursor: "44", hasMore: false });

  const result = await pulling;
  assert.equal(result.blocked, true);
  assert.deepEqual(state.entity, newerLocal);
  assert.deepEqual(notificationEvents, ["拉取期间的新编辑@2026-08-22T04:00:00.000Z"]);
  assert.deepEqual(committedCursors, []);
  assert.equal(state.outbox[0]?.baseRevision, 3);
});

test("pull BLOCKED 后 outbox 若被 Worker 清掉但无持久冲突，仍从旧 cursor 重放", () => {
  const blocked = [{ entityType: "PERSONAL_REMINDER" as const, entityId: "reminder-a" }];
  assert.equal(shouldRepeatBlockedPull(false, blocked, []), true);
  assert.equal(
    shouldRepeatBlockedPull(false, blocked, [
      { entityType: "PERSONAL_REMINDER", entityId: "reminder-a" },
    ]),
    false,
  );
  assert.equal(shouldRepeatBlockedPull(true, blocked, []), true);
});
