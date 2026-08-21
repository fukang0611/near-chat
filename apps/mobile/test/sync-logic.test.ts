import assert from "node:assert/strict";
import test from "node:test";
import {
  accountViewKey,
  canInitializeDefaultWorkspace,
  createInitializationGate,
} from "../src/app-lifecycle.ts";
import { createDefaultAssistantWorkspace } from "../src/assistant-defaults.ts";
import {
  accountNamespace,
  asSyncOperation,
  canRetryLocalConflict,
  conflictBaseRevision,
  conflictRetryPlan,
  isConflictServerDeleted,
  normalizeModelBaseUrl,
  notificationIdFor,
  refreshConflictFromRemoteChange,
  resolveBaseRevision,
  selectUniqueEntityOperations,
  splitSyncPushBatches,
} from "../src/sync-logic.ts";

test("模型地址在保存前执行 HTTPS 与凭据边界", () => {
  assert.equal(
    normalizeModelBaseUrl("https://model.example/v1/", false),
    "https://model.example/v1",
  );
  assert.equal(
    normalizeModelBaseUrl("http://192.168.1.8:8000/v1", true),
    "http://192.168.1.8:8000/v1",
  );
  assert.throws(() => normalizeModelBaseUrl("http://model.example/v1", false), /只允许 HTTPS/);
  assert.throws(() => normalizeModelBaseUrl("file:///tmp/model", true), /只支持 HTTP 或 HTTPS/);
  assert.throws(
    () => normalizeModelBaseUrl("https://user:secret@model.example/v1", false),
    /用户名或密码/,
  );
  assert.throws(
    () => normalizeModelBaseUrl("https://model.example/v1?api_key=secret", false),
    /查询参数或片段/,
  );
});

test("cursor/outbox 命名空间同时隔离服务器、用户和设备", () => {
  const base = accountNamespace("https://near.example/", "user-a", "device-a");
  assert.equal(base, accountNamespace("https://near.example", "user-a", "device-a"));
  assert.notEqual(base, accountNamespace("https://other.example", "user-a", "device-a"));
  assert.notEqual(base, accountNamespace("https://near.example", "user-b", "device-a"));
  assert.notEqual(base, accountNamespace("https://near.example", "user-a", "device-b"));
});

test("新建实体保留显式 null，更新使用当前服务器 revision", () => {
  assert.equal(resolveBaseRevision(1, { baseRevision: null }), null);
  assert.equal(resolveBaseRevision(0, {}), null);
  assert.equal(resolveBaseRevision(7, {}), 7);
  assert.equal(resolveBaseRevision(7, { baseRevision: 9 }), 9);
});

test("OPERATION_ID_REUSED 的零版本冲突重试不会发送 baseRevision=0", () => {
  assert.equal(conflictBaseRevision(0), null);
  assert.equal(conflictBaseRevision(-1), null);
  assert.equal(conflictBaseRevision(6), 6);
});

test("过期 DELETE 冲突保留删除意图并使用最新服务器版本重试", () => {
  const plan = conflictRetryPlan({
    operationId: "9c511344-6942-4a94-a7d3-ad8ec97435f8",
    accountKey: "account-a",
    entityType: "PERSONAL_TASK",
    entityId: "167e9178-fe15-4dac-af23-0680c1fd748f",
    reason: "STALE_REVISION",
    serverRevision: 4,
    serverPayload: { title: "服务器 r4" },
    serverOperation: "UPSERT",
    localPayload: {},
    localOperation: "DELETE",
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  assert.deepEqual(plan, { operation: "DELETE", baseRevision: 4, serverDeleted: false });
});

test("pull 在推进游标前把后续 UPSERT 刷新为冲突的最新服务器版本", () => {
  const conflict = {
    operationId: "9c511344-6942-4a94-a7d3-ad8ec97435f8",
    accountKey: "account-a",
    entityType: "MEMORY" as const,
    entityId: "167e9178-fe15-4dac-af23-0680c1fd748f",
    reason: "OPERATION_ID_REUSED" as const,
    serverRevision: 0,
    serverPayload: {},
    serverOperation: "UPSERT" as const,
    localPayload: { title: "本机版本" },
    localOperation: "UPSERT" as const,
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  const refreshed = refreshConflictFromRemoteChange(conflict, {
    sequence: "42",
    entityType: "MEMORY",
    entityId: conflict.entityId,
    operation: "UPSERT",
    revision: 3,
    payload: { title: "服务器 r3", content: "最新内容" },
    occurredAt: "2026-08-21T00:01:00.000Z",
  });
  assert.equal(refreshed.cursorCanAdvance, true);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.conflict.serverRevision, 3);
  assert.deepEqual(refreshed.conflict.serverPayload, {
    title: "服务器 r3",
    content: "最新内容",
  });
  assert.deepEqual(refreshed.conflict.localPayload, conflict.localPayload);
});

test("冲突期间的 DELETE 被持久化为 tombstone 后可安全推进游标", () => {
  const conflict = {
    operationId: "9c511344-6942-4a94-a7d3-ad8ec97435f8",
    accountKey: "account-a",
    entityType: "PERSONAL_REMINDER" as const,
    entityId: "167e9178-fe15-4dac-af23-0680c1fd748f",
    reason: "STALE_REVISION" as const,
    serverRevision: 2,
    serverPayload: { title: "服务器 r2" },
    serverOperation: "UPSERT" as const,
    localPayload: { title: "本机版本" },
    localOperation: "UPSERT" as const,
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  const deferred = refreshConflictFromRemoteChange(conflict, {
    sequence: "43",
    entityType: "PERSONAL_REMINDER",
    entityId: conflict.entityId,
    operation: "DELETE",
    revision: 3,
    payload: {},
    occurredAt: "2026-08-21T00:02:00.000Z",
  });
  assert.equal(deferred.cursorCanAdvance, true);
  assert.equal(deferred.changed, true);
  assert.equal(deferred.conflict.serverOperation, "DELETE");
  assert.equal(deferred.conflict.serverRevision, 3);
  assert.equal(deferred.conflict.serverPayload.deletedAt, "2026-08-21T00:02:00.000Z");
});

test("服务端已删除的助理层级不提供会产生孤儿节点的单实体重建", () => {
  assert.equal(canRetryLocalConflict("ASSISTANT", "ENTITY_DELETED"), false);
  assert.equal(canRetryLocalConflict("ASSISTANT_THREAD", "ENTITY_DELETED"), false);
  assert.equal(canRetryLocalConflict("ASSISTANT_MESSAGE", "ENTITY_DELETED"), false);
  assert.equal(canRetryLocalConflict("PERSONAL_REMINDER", "ENTITY_DELETED"), true);
  assert.equal(canRetryLocalConflict("ASSISTANT_MESSAGE", "APPEND_ONLY"), true);
  assert.equal(canRetryLocalConflict("ASSISTANT", "OPERATION_ID_REUSED", true), false);
});

test("operationId 复用只在服务端确实无实体或返回 tombstone 时采用删除语义", () => {
  const base = {
    operationId: "9c511344-6942-4a94-a7d3-ad8ec97435f8",
    accountKey: "account-a",
    entityType: "MEMORY" as const,
    entityId: "167e9178-fe15-4dac-af23-0680c1fd748f",
    reason: "OPERATION_ID_REUSED" as const,
    serverOperation: "UPSERT" as const,
    localPayload: { title: "本机版本" },
    localOperation: "UPSERT" as const,
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  assert.equal(
    isConflictServerDeleted({ ...base, serverRevision: 3, serverPayload: { title: "r3" } }),
    false,
  );
  assert.equal(isConflictServerDeleted({ ...base, serverRevision: 0, serverPayload: {} }), true);
  assert.equal(
    isConflictServerDeleted({
      ...base,
      serverRevision: 4,
      serverPayload: { deletedAt: "2026-08-21T00:03:00.000Z" },
    }),
    true,
  );
});

test("重试沿用 outbox 中持久化的 operationId", () => {
  const stored = {
    operationId: "9c511344-6942-4a94-a7d3-ad8ec97435f8",
    entityType: "PERSONAL_TASK" as const,
    entityId: "167e9178-fe15-4dac-af23-0680c1fd748f",
    operation: "UPSERT" as const,
    baseRevision: null,
    payload: { title: "离线任务" },
    deviceCreatedAt: "2026-08-21T00:00:00.000Z",
  };
  assert.equal(asSyncOperation(stored).operationId, stored.operationId);
  assert.equal(asSyncOperation(stored).operationId, asSyncOperation(stored).operationId);
});

test("单个 push 批次不会并发发送同一实体的多条操作", () => {
  const operations = [
    { entityType: "MEMORY", entityId: "a", operationId: "first" },
    { entityType: "MEMORY", entityId: "a", operationId: "second" },
    { entityType: "MEMORY", entityId: "b", operationId: "third" },
  ];
  assert.deepEqual(
    selectUniqueEntityOperations(operations).map((operation) => operation.operationId),
    ["first", "third"],
  );
});

test("助理同步按外键依赖稳定排序，删除时反向", () => {
  const upserts = [
    { entityType: "ASSISTANT_MESSAGE", entityId: "m", operation: "UPSERT", operationId: "message" },
    { entityType: "PERSONAL_TASK", entityId: "x", operation: "UPSERT", operationId: "task" },
    { entityType: "ASSISTANT_THREAD", entityId: "t", operation: "UPSERT", operationId: "thread" },
    { entityType: "ASSISTANT", entityId: "a", operation: "UPSERT", operationId: "assistant" },
  ];
  assert.deepEqual(
    selectUniqueEntityOperations(upserts).map((operation) => operation.operationId),
    ["task", "assistant", "thread", "message"],
  );
  const deletes = [
    { entityType: "ASSISTANT", entityId: "a", operation: "DELETE", operationId: "assistant" },
    { entityType: "ASSISTANT_THREAD", entityId: "t", operation: "DELETE", operationId: "thread" },
    { entityType: "ASSISTANT_MESSAGE", entityId: "m", operation: "DELETE", operationId: "message" },
  ];
  assert.deepEqual(
    selectUniqueEntityOperations(deletes).map((operation) => operation.operationId),
    ["message", "thread", "assistant"],
  );
});

test("依赖排序先遍历整个积压队列，再切 100 条批次", () => {
  const operations = [
    {
      entityType: "ASSISTANT_THREAD",
      entityId: "thread",
      operation: "UPSERT",
      operationId: "thread",
    },
    ...Array.from({ length: 99 }, (_, index) => ({
      entityType: "PERSONAL_TASK",
      entityId: `task-${index}`,
      operation: "UPSERT",
      operationId: `task-${index}`,
    })),
    {
      entityType: "ASSISTANT",
      entityId: "assistant",
      operation: "UPSERT",
      operationId: "assistant",
    },
  ];
  const selected = selectUniqueEntityOperations(operations, 100);
  assert.equal(selected.length, 100);
  assert.ok(selected.some((operation) => operation.operationId === "assistant"));
  assert.ok(!selected.some((operation) => operation.operationId === "thread"));
});

test("合法的大消息积压按最终 UTF-8 JSON 字节预算拆批且不丢操作", () => {
  const operations = Array.from({ length: 24 }, (_, index) => ({
    operationId: crypto.randomUUID(),
    entityType: "ASSISTANT_MESSAGE" as const,
    entityId: crypto.randomUUID(),
    operation: "UPSERT" as const,
    baseRevision: null,
    payload: {
      assistantId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      role: "USER",
      content: "中".repeat(50_000),
      modelId: null,
      sources: [],
    },
    deviceCreatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const batches = splitSyncPushBatches("device-a", operations);
  assert.ok(batches.length > 1);
  assert.deepEqual(
    batches.flat().map((operation) => operation.operationId),
    operations.map((operation) => operation.operationId),
  );
  for (const batch of batches) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ deviceId: "device-a", operations: batch }),
    ).byteLength;
    assert.ok(bytes <= 768 * 1024);
  }
});

test("本地通知 ID 跨调用稳定且为正整数", () => {
  const id = notificationIdFor("167e9178-fe15-4dac-af23-0680c1fd748f");
  assert.equal(id, notificationIdFor("167e9178-fe15-4dac-af23-0680c1fd748f"));
  assert.ok(Number.isInteger(id));
  assert.ok(id > 0);
});

test("StrictMode 重复 effect 只允许一次初始化", () => {
  const begin = createInitializationGate();
  assert.equal(begin(), true);
  assert.equal(begin(), false);
  assert.equal(begin(), false);
});

test("团队默认助理等待 bootstrap，本地命名空间可立即初始化", () => {
  assert.equal(canInitializeDefaultWorkspace(null, ""), true);
  assert.equal(canInitializeDefaultWorkspace("account-a", ""), false);
  assert.equal(canInitializeDefaultWorkspace("account-a", "account-b"), false);
  assert.equal(canInitializeDefaultWorkspace("account-a", "account-a"), true);
});

test("账号或会话代次变化都会生成新的页面生命周期 key", () => {
  const original = accountViewKey("team-a", "generation-a");
  assert.notEqual(original, accountViewKey("team-b", "generation-a"));
  assert.notEqual(original, accountViewKey("team-a", "generation-b"));
});

test("不同账号初始化不会共享固定 assistant/thread 主键", () => {
  const first = createDefaultAssistantWorkspace("2026-08-21T00:00:00.000Z");
  const second = createDefaultAssistantWorkspace("2026-08-21T00:00:00.000Z");
  assert.notEqual(first.assistant.id, second.assistant.id);
  assert.notEqual(first.thread.id, second.thread.id);
  assert.equal(first.thread.assistantId, first.assistant.id);
  assert.match(first.assistant.id, /^[0-9a-f-]{36}$/i);
});
