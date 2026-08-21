import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  lockAllOwnerSyncStreams,
  lockOwnerSyncStreams,
  recordSyncSnapshot,
} from "./sync-projection.js";

test("owner 同步锁固定按 global shared 与排序后的 owner exclusive 获取", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await lockOwnerSyncStreams(client, ["owner-b", "owner-a", "owner-b"]);

  assert.equal(calls.length, 3);
  assert.match(calls[0]!.text, /pg_advisory_xact_lock_shared/);
  assert.deepEqual(calls[0]!.params, ["near-chat:sync-stream:global:v1"]);
  assert.match(calls[1]!.text, /pg_advisory_xact_lock\(/);
  assert.deepEqual(calls[1]!.params, ["near-chat:sync-stream:owner:owner-a"]);
  assert.deepEqual(calls[2]!.params, ["near-chat:sync-stream:owner:owner-b"]);
});

test("动态跨 owner 写入独占 global 同步锁", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [] };
    },
  } as unknown as PoolClient;

  await lockAllOwnerSyncStreams(client);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /pg_advisory_xact_lock\(/);
  assert.doesNotMatch(calls[0]!.text, /_shared/);
  assert.deepEqual(calls[0]!.params, ["near-chat:sync-stream:global:v1"]);
});

function clientWithSnapshot(payload: Record<string, unknown>) {
  let writes = 0;
  const client = {
    async query(text: string) {
      if (text.includes("FROM sync_entity_snapshots")) {
        return {
          rows: [
            {
              entity_type: "PERSONAL_TASK",
              entity_id: "00000000-0000-4000-8000-000000000001",
              revision: 2,
              payload,
              deleted_at: null,
              updated_at: new Date("2026-08-21T00:00:00.000Z"),
            },
          ],
        };
      }
      writes += 1;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, writes: () => writes };
}

test("同步投影同 revision 同内容幂等，不重复产生 change", async () => {
  const fixture = clientWithSnapshot({ title: "任务", revision: 2 });
  const result = await recordSyncSnapshot(
    fixture.client,
    "00000000-0000-4000-8000-000000000002",
    "PERSONAL_TASK",
    "00000000-0000-4000-8000-000000000001",
    2,
    { title: "任务", revision: 2 },
  );
  assert.equal(result, null);
  assert.equal(fixture.writes(), 0);
});

test("同步投影拒绝同 revision 不同内容", async () => {
  const fixture = clientWithSnapshot({ title: "服务器任务", revision: 2 });
  await assert.rejects(
    recordSyncSnapshot(
      fixture.client,
      "00000000-0000-4000-8000-000000000002",
      "PERSONAL_TASK",
      "00000000-0000-4000-8000-000000000001",
      2,
      { title: "离线覆盖", revision: 2 },
    ),
    /同步投影版本冲突/,
  );
  assert.equal(fixture.writes(), 0);
});
