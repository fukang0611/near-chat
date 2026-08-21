import assert from "node:assert/strict";
import test from "node:test";
import type { SyncChange, SyncOperation } from "@near-chat/domain";
import { ApiError } from "./http.js";
import {
  jsonUtf8ByteLength,
  paginateBootstrapSnapshotsByByteBudget,
  paginatePullChangesByByteBudget,
  selectSyncPayloadMetadataWithinBudget,
  signBootstrapPageToken,
  syncOperationFingerprint,
  verifyBootstrapPageToken,
  type BootstrapPageTokenState,
} from "./sync-service.js";

test("operation 指纹忽略 JSON 键顺序但能识别 payload 被复用", () => {
  const operation: SyncOperation = {
    operationId: "00000000-0000-4000-8000-000000000001",
    entityType: "PERSONAL_RECORD",
    entityId: "00000000-0000-4000-8000-000000000002",
    operation: "UPSERT",
    baseRevision: null,
    payload: { title: "记录", content: "正文" },
    deviceCreatedAt: "2026-08-21T00:00:00.000Z",
  };
  assert.equal(
    syncOperationFingerprint(operation),
    syncOperationFingerprint({ ...operation, payload: { content: "正文", title: "记录" } }),
  );
  assert.notEqual(
    syncOperationFingerprint(operation),
    syncOperationFingerprint({ ...operation, payload: { title: "记录", content: "已篡改" } }),
  );
});

test("bootstrap page token 验签并绑定 owner、device 与有效期", () => {
  const now = Date.parse("2026-08-21T00:00:00.000Z");
  const ownerId = "00000000-0000-4000-8000-000000000101";
  const deviceId = "00000000-0000-4000-8000-000000000102";
  const state: BootstrapPageTokenState = {
    version: 1,
    ownerId,
    deviceId,
    phase: "SNAPSHOT",
    afterEntityType: "PERSONAL_RECORD",
    afterEntityId: "00000000-0000-4000-8000-000000000103",
    watermark: "42",
    expiresAt: now + 60_000,
  };
  const token = signBootstrapPageToken(state, "test-secret");
  assert.deepEqual(verifyBootstrapPageToken(token, ownerId, deviceId, "test-secret", now), state);

  const [payload, signature] = token.split(".") as [string, string];
  const middle = Math.floor(payload.length / 2);
  const tamperedPayload = `${payload.slice(0, middle)}${payload[middle] === "A" ? "B" : "A"}${payload.slice(
    middle + 1,
  )}.${signature}`;
  assert.throws(
    () => verifyBootstrapPageToken(tamperedPayload, ownerId, deviceId, "test-secret", now),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.throws(
    () =>
      verifyBootstrapPageToken(
        token,
        "00000000-0000-4000-8000-000000000199",
        deviceId,
        "test-secret",
        now,
      ),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.throws(
    () =>
      verifyBootstrapPageToken(
        token,
        ownerId,
        "00000000-0000-4000-8000-000000000198",
        "test-secret",
        now,
      ),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.throws(
    () => verifyBootstrapPageToken(token, ownerId, deviceId, "test-secret", state.expiresAt),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test("pull 按最终 UTF-8 JSON 字节预算截断且 cursor 只到实际末条", () => {
  const change = (sequence: string, entityId: string, content: string): SyncChange => ({
    sequence,
    entityType: "ASSISTANT_MESSAGE",
    entityId,
    operation: "UPSERT",
    revision: 1,
    payload: { content },
    occurredAt: "2026-08-21T00:00:00.000Z",
  });
  const first = change("11", "00000000-0000-4000-8000-000000000201", "中文正文".repeat(20));
  const second = change("12", "00000000-0000-4000-8000-000000000202", "第二条".repeat(20));
  const oneChangeResponse = { changes: [first], cursor: "11", hasMore: true };
  const budget = jsonUtf8ByteLength(oneChangeResponse);
  assert.ok(budget > JSON.stringify(oneChangeResponse).length);

  const page = paginatePullChangesByByteBudget([first, second], "10", 500, budget);
  assert.deepEqual(page, oneChangeResponse);
  assert.ok(jsonUtf8ByteLength(page) <= budget);

  assert.throws(
    () => paginatePullChangesByByteBudget([first], "10", 500, budget - 1),
    (error) =>
      error instanceof ApiError &&
      error.status === 413 &&
      error.message.includes("ASSISTANT_MESSAGE/00000000-0000-4000-8000-000000000201"),
  );
});

test("bootstrap snapshot 把签名 token 计入最终 JSON 字节预算", () => {
  const ownerId = "00000000-0000-4000-8000-000000000301";
  const deviceId = "00000000-0000-4000-8000-000000000302";
  const change = (entityId: string, content: string): SyncChange => ({
    sequence: "0",
    entityType: "PERSONAL_RECORD",
    entityId,
    operation: "UPSERT",
    revision: 1,
    payload: { content },
    occurredAt: "2026-08-21T00:00:00.000Z",
  });
  const first = change("00000000-0000-4000-8000-000000000303", "第一页中文".repeat(20));
  const second = change("00000000-0000-4000-8000-000000000304", "第二页中文".repeat(20));
  const baseOptions = {
    ownerId,
    deviceId,
    watermark: "88",
    expiresAt: Date.parse("2026-08-22T00:00:00.000Z"),
    tokenSecret: "bootstrap-budget-secret",
    responseByteBudget: 1024 * 1024,
  };
  const oneItemPage = paginateBootstrapSnapshotsByByteBudget([first, second], {
    ...baseOptions,
    pageSize: 1,
  });
  const budget = jsonUtf8ByteLength(oneItemPage);
  const page = paginateBootstrapSnapshotsByByteBudget([first, second], {
    ...baseOptions,
    pageSize: 2,
    responseByteBudget: budget,
  });
  assert.equal(page.changes.length, 1);
  assert.equal(page.cursor, null);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.nextPageToken, "string");
  assert.ok(jsonUtf8ByteLength(page) <= budget);

  const finalOneItem = paginateBootstrapSnapshotsByByteBudget([first], {
    ...baseOptions,
    pageSize: 1,
  });
  assert.throws(
    () =>
      paginateBootstrapSnapshotsByByteBudget([first], {
        ...baseOptions,
        pageSize: 1,
        responseByteBudget: jsonUtf8ByteLength(finalOneItem) - 1,
      }),
    (error) => error instanceof ApiError && error.status === 413,
  );
});

test("SQL payload 元数据预算只允许有界正文进入 Node，超大首条直接诊断", () => {
  const metadata = (entityId: string, payloadBytes: number) => ({
    entity_type: "ASSISTANT_MESSAGE" as const,
    entity_id: entityId,
    payload_bytes: payloadBytes,
  });
  const first = metadata("00000000-0000-4000-8000-000000000601", 1000);
  const second = metadata("00000000-0000-4000-8000-000000000602", 1000);
  assert.deepEqual(selectSyncPayloadMetadataWithinBudget([first, second], 4096), [first]);
  assert.throws(
    () =>
      selectSyncPayloadMetadataWithinBudget(
        [metadata("00000000-0000-4000-8000-000000000603", 5000)],
        4096,
      ),
    (error) =>
      error instanceof ApiError &&
      error.status === 413 &&
      error.message.includes("00000000-0000-4000-8000-000000000603"),
  );
});
