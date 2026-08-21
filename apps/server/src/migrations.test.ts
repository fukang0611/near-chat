import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { DatabaseMigration } from "./migrations.js";
import { databaseMigrations, orderedPendingMigrations } from "./migrations.js";

function migration(version: number): DatabaseMigration {
  return { version, name: `migration-${version}`, up: async () => undefined };
}

test("数据库迁移按版本执行并跳过已应用项", () => {
  const result = orderedPendingMigrations(
    [migration(30), migration(10), migration(20)],
    new Set([20]),
  );
  assert.deepEqual(
    result.map((item) => item.version),
    [10, 30],
  );
});

test("数据库迁移拒绝无效或重复版本", () => {
  assert.throws(() => orderedPendingMigrations([migration(0)], new Set()), /正整数/);
  assert.throws(
    () => orderedPendingMigrations([migration(10), migration(10)], new Set()),
    /版本重复/,
  );
});

test("记忆领域迁移保持稳定的首个版本", () => {
  assert.deepEqual(
    databaseMigrations.map(({ version, name }) => ({ version, name })),
    [
      { version: 1, name: "create_memory_domain" },
      { version: 2, name: "create_memory_candidates_and_settings" },
      { version: 3, name: "add_semantic_memory_capture_pipeline" },
      { version: 4, name: "add_assistant_retrieval_tools" },
      { version: 5, name: "add_chat_assistant_invocations" },
      { version: 6, name: "create_personal_sync_and_connector_domains" },
      { version: 7, name: "harden_sync_and_connector_delivery" },
      { version: 8, name: "harden_connector_operations_and_message_idempotency" },
      { version: 9, name: "minimize_memory_sync_tombstones" },
    ],
  );
});

test("v9 清理记忆 tombstone 在同步存储中的历史正文副本", async () => {
  const statements: string[] = [];
  const client = {
    async query(statement: string) {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const migration = databaseMigrations.find((item) => item.version === 9)!;
  await migration.up(client);
  const sql = statements.join("\n");
  assert.match(sql, /UPDATE sync_entity_snapshots/);
  assert.match(sql, /UPDATE sync_changes/);
  assert.match(sql, /UPDATE sync_operations/);
  assert.match(sql, /\{applied,payload\}/);
  assert.match(sql, /jsonb_build_object\(\s*'id', entity_id,\s*'revision'/);
});

test("v8 约束连接器事件助理消息幂等并增加可运维终态", async () => {
  const statements: string[] = [];
  const client = {
    async query(statement: string) {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const migration = databaseMigrations.find((item) => item.version === 8)!;
  await migration.up(client);
  const sql = statements.join("\n");
  assert.match(sql, /ADD COLUMN connector_event_id UUID/);
  assert.match(sql, /UNIQUE INDEX uq_ai_assistant_messages_connector_event_role/);
  assert.match(sql, /delivery_target_expires_at TIMESTAMPTZ/);
  assert.match(sql, /'CANCELLED'/);
});

test("v7 在数据库层禁止同一同步实体 revision 产生重复增量", async () => {
  const statements: string[] = [];
  const client = {
    async query(statement: string) {
      statements.push(statement);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const migration = databaseMigrations.find((item) => item.version === 7)!;
  await migration.up(client);
  assert.match(
    statements.join("\n"),
    /CREATE UNIQUE INDEX uq_sync_changes_entity_revision\s+ON sync_changes\(owner_id, entity_type, entity_id, revision\)/,
  );
});
