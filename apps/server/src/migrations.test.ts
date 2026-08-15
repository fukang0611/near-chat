import assert from "node:assert/strict";
import test from "node:test";
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
    [{ version: 1, name: "create_memory_domain" }],
  );
});
