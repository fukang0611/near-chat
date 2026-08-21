import assert from "node:assert/strict";
import test from "node:test";
import {
  isSyncEntityType,
  isPersonalEntityType,
  resolveCompletedAt,
  resolveSyncOperation,
  type SyncOperation,
} from "./index.js";

test("completed 任务不会被旧离线状态重新打开", () => {
  assert.equal(resolveCompletedAt("2026-08-20T00:00:00.000Z", null), "2026-08-20T00:00:00.000Z");
  assert.equal(resolveCompletedAt(null, "2026-08-20T00:00:00.000Z"), "2026-08-20T00:00:00.000Z");
});

test("同步协议只接受明确列出的实体", () => {
  assert.equal(isSyncEntityType("PERSONAL_RECORD"), true);
  assert.equal(isSyncEntityType("ATTACHMENT"), false);
  assert.equal(isPersonalEntityType("PERSONAL_REMINDER"), true);
  assert.equal(isPersonalEntityType("MEMORY"), false);
});

test("同步写入以服务端 revision、tombstone 和完成状态为准", () => {
  const operation: SyncOperation = {
    operationId: "00000000-0000-4000-8000-000000000001",
    entityType: "PERSONAL_TASK",
    entityId: "00000000-0000-4000-8000-000000000002",
    operation: "UPSERT",
    baseRevision: 2,
    payload: { title: "离线任务", completedAt: null },
    deviceCreatedAt: "2026-08-21T00:00:00.000Z",
  };

  assert.deepEqual(resolveSyncOperation(operation, null), {
    kind: "CONFLICT",
    reason: "STALE_REVISION",
    serverRevision: 0,
  });
  assert.deepEqual(
    resolveSyncOperation(operation, {
      revision: 2,
      deleted: false,
      completedAt: "2026-08-20T00:00:00.000Z",
    }),
    {
      kind: "CONFLICT",
      reason: "COMPLETED_MONOTONIC",
      serverRevision: 2,
    },
  );
  assert.deepEqual(
    resolveSyncOperation(
      { ...operation, baseRevision: 3, payload: { title: "离线任务", completedAt: null } },
      { revision: 3, deleted: true, completedAt: null },
    ),
    {
      kind: "CONFLICT",
      reason: "ENTITY_DELETED",
      serverRevision: 3,
    },
  );
});
