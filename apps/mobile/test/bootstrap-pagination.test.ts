import assert from "node:assert/strict";
import test from "node:test";
import type { SyncChange } from "@near-chat/domain";
import { consumeBootstrapPages, type BootstrapPage } from "../src/bootstrap-pagination.ts";

function change(sequence: string): SyncChange {
  return {
    sequence,
    entityType: "PERSONAL_RECORD",
    entityId: `record-${sequence}`,
    operation: "UPSERT",
    revision: 1,
    payload: { title: sequence },
    occurredAt: "2026-08-21T00:00:00.000Z",
  };
}

test("bootstrap 循环回传页令牌且只在完整末页提交冻结 watermark", async () => {
  const pages = new Map<string | undefined, BootstrapPage>([
    [
      undefined,
      {
        phase: "BACKFILL",
        changes: [],
        watermark: "42",
        cursor: null,
        hasMore: true,
        nextPageToken: "backfill-2",
      },
    ],
    [
      "backfill-2",
      {
        phase: "SNAPSHOT",
        changes: [change("0")],
        watermark: "42",
        cursor: null,
        hasMore: true,
        nextPageToken: "snapshot-2",
      },
    ],
    [
      "snapshot-2",
      {
        phase: "SNAPSHOT",
        changes: [change("0")],
        watermark: "42",
        cursor: "42",
        hasMore: false,
        nextPageToken: null,
      },
    ],
  ]);
  const requested: Array<string | undefined> = [];
  const committed: string[] = [];
  const applied: string[] = [];

  const count = await consumeBootstrapPages({
    fetchPage: async (token) => {
      requested.push(token);
      return pages.get(token)!;
    },
    applyChange: async (item) => {
      applied.push(item.entityId);
      return "APPLIED";
    },
    commitCursor: async (cursor) => {
      committed.push(cursor);
    },
    shouldRestartToken: () => false,
    shouldContinue: () => true,
  });

  assert.equal(count, 2);
  assert.deepEqual(requested, [undefined, "backfill-2", "snapshot-2"]);
  assert.deepEqual(applied, ["record-0", "record-0"]);
  assert.deepEqual(committed, ["42"]);
});

test("过期页令牌只重启一次且不会提交旧 watermark", async () => {
  const requested: Array<string | undefined> = [];
  const committed: string[] = [];
  let firstAttempt = true;

  await consumeBootstrapPages({
    fetchPage: async (token) => {
      requested.push(token);
      if (token === "expired") {
        firstAttempt = false;
        throw new Error("expired token");
      }
      return firstAttempt
        ? {
            phase: "SNAPSHOT",
            changes: [change("0")],
            watermark: "10",
            cursor: null,
            hasMore: true,
            nextPageToken: "expired",
          }
        : {
            phase: "SNAPSHOT",
            changes: [change("0")],
            watermark: "12",
            cursor: "12",
            hasMore: false,
            nextPageToken: null,
          };
    },
    applyChange: async () => "APPLIED",
    commitCursor: async (cursor) => {
      committed.push(cursor);
    },
    shouldRestartToken: (error) => error instanceof Error && error.message.includes("expired"),
    shouldContinue: () => true,
  });

  assert.deepEqual(requested, [undefined, "expired", undefined]);
  assert.deepEqual(committed, ["12"]);
});

test("中间页失败时不提交 cursor，下一次可从头重放", async () => {
  const committed: string[] = [];
  await assert.rejects(
    consumeBootstrapPages({
      fetchPage: async () => ({
        phase: "SNAPSHOT",
        changes: [change("0")],
        watermark: "20",
        cursor: null,
        hasMore: true,
        nextPageToken: "next",
      }),
      applyChange: async () => "BLOCKED",
      commitCursor: async (cursor) => {
        committed.push(cursor);
      },
      shouldRestartToken: () => false,
      shouldContinue: () => true,
    }),
    /游标已保留/,
  );
  assert.deepEqual(committed, []);
});
