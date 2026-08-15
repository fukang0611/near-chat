import type { Pool, PoolClient } from "pg";

// 固定的 bigint 锁编号只用于 NearChat 数据库迁移；显式转换类型，避免 PostgreSQL
// 在 int4 / int8 两个同名函数之间无法推断参数类型。
const MIGRATION_LOCK_ID = "7241903517";

export interface DatabaseMigration {
  version: number;
  name: string;
  up(client: PoolClient): Promise<void>;
}

/**
 * 现有内联 Schema 继续作为旧版本数据库的兼容基线；从本阶段开始，新增领域表和
 * 破坏性较低的增量修改统一进入有序迁移，避免启动 SQL 随功能增长继续失控。
 */
export const databaseMigrations: DatabaseMigration[] = [];

export function orderedPendingMigrations(
  migrations: DatabaseMigration[],
  appliedVersions: ReadonlySet<number>,
): DatabaseMigration[] {
  const byVersion = new Map<number, DatabaseMigration>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`数据库迁移版本必须是正整数：${migration.version}`);
    }
    if (byVersion.has(migration.version)) {
      throw new Error(`数据库迁移版本重复：${migration.version}`);
    }
    byVersion.set(migration.version, migration);
  }
  return [...byVersion.values()]
    .sort((left, right) => left.version - right.version)
    .filter((migration) => !appliedVersions.has(migration.version));
}

export async function runDatabaseMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const applied = await pool.query<{ version: number }>(
    `SELECT version FROM schema_migrations ORDER BY version`,
  );
  const pending = orderedPendingMigrations(
    databaseMigrations,
    new Set(applied.rows.map((row) => row.version)),
  );

  for (const migration of pending) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 多副本同时启动时，只允许一个实例应用当前迁移。获得锁后再次检查版本，
      // 避免另一个实例已经在等待期间完成相同迁移。
      await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [MIGRATION_LOCK_ID]);
      const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [
        migration.version,
      ]);
      if (!existing.rowCount) {
        await migration.up(client);
        await client.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [
          migration.version,
          migration.name,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
