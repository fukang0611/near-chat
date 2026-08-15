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
export const databaseMigrations: DatabaseMigration[] = [
  {
    version: 1,
    name: "create_memory_domain",
    async up(client) {
      await client.query(`
        CREATE TABLE memories (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tier VARCHAR(20) NOT NULL DEFAULT 'LONG_TERM'
            CHECK (tier IN ('SHORT_TERM', 'LONG_TERM')),
          scope VARCHAR(20) NOT NULL DEFAULT 'PRIVATE'
            CHECK (scope IN ('PRIVATE', 'CONVERSATION')),
          conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          kind VARCHAR(30) NOT NULL
            CHECK (kind IN (
              'PREFERENCE', 'PERSON', 'PROJECT', 'DECISION',
              'PROCEDURE', 'GOAL', 'NOTE', 'TASK_CONTEXT'
            )),
          title VARCHAR(120) NOT NULL,
          content TEXT NOT NULL,
          importance SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
            CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ,
          CHECK (
            (scope = 'PRIVATE' AND conversation_id IS NULL)
            OR (scope = 'CONVERSATION' AND conversation_id IS NOT NULL)
          )
        );

        CREATE TABLE memory_revisions (
          id UUID PRIMARY KEY,
          memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision > 0),
          kind VARCHAR(30) NOT NULL,
          title VARCHAR(120) NOT NULL,
          content TEXT NOT NULL,
          importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
          change_type VARCHAR(20) NOT NULL
            CHECK (change_type IN ('CREATE', 'APPEND', 'CORRECT', 'MERGE', 'SUPERSEDE', 'FORGET')),
          changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (memory_id, revision)
        );

        CREATE TABLE memory_sources (
          id UUID PRIMARY KEY,
          memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          source_type VARCHAR(30) NOT NULL
            CHECK (source_type IN (
              'MESSAGE', 'ASSISTANT_MESSAGE', 'FILE', 'TASK', 'REMINDER', 'MANUAL'
            )),
          source_id UUID,
          conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          label VARCHAR(160) NOT NULL,
          excerpt TEXT,
          source_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX idx_memories_owner_active
          ON memories(owner_id, updated_at DESC, id DESC)
          WHERE status = 'ACTIVE';
        CREATE INDEX idx_memories_owner_kind
          ON memories(owner_id, kind, updated_at DESC)
          WHERE status = 'ACTIVE';
        CREATE INDEX idx_memory_revisions_history
          ON memory_revisions(memory_id, revision DESC);
        CREATE INDEX idx_memory_sources_memory
          ON memory_sources(memory_id, source_created_at DESC, id DESC);
      `);
    },
  },
  {
    version: 2,
    name: "create_memory_candidates_and_settings",
    async up(client) {
      await client.query(`
        CREATE TABLE memory_candidates (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_type VARCHAR(30) NOT NULL
            CHECK (source_type IN (
              'MESSAGE', 'ASSISTANT_MESSAGE', 'FILE', 'TASK', 'REMINDER', 'MANUAL'
            )),
          source_id UUID,
          conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          source_label VARCHAR(160) NOT NULL,
          source_excerpt TEXT,
          source_created_at TIMESTAMPTZ NOT NULL,
          kind VARCHAR(30) NOT NULL
            CHECK (kind IN (
              'PREFERENCE', 'PERSON', 'PROJECT', 'DECISION',
              'PROCEDURE', 'GOAL', 'NOTE', 'TASK_CONTEXT'
            )),
          title VARCHAR(120) NOT NULL,
          content TEXT NOT NULL,
          importance SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ
        );

        CREATE TABLE memory_settings (
          owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          explicit_capture_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX idx_memory_candidates_owner_pending
          ON memory_candidates(owner_id, created_at DESC, id DESC)
          WHERE status = 'PENDING';
        CREATE UNIQUE INDEX idx_memory_candidates_pending_source
          ON memory_candidates(owner_id, source_type, source_id)
          WHERE status = 'PENDING' AND source_id IS NOT NULL;
        CREATE INDEX idx_memories_owner_tier_active
          ON memories(owner_id, tier, updated_at DESC, id DESC)
          WHERE status = 'ACTIVE';
      `);
    },
  },
  {
    version: 3,
    name: "add_semantic_memory_capture_pipeline",
    async up(client) {
      await client.query(`
        ALTER TABLE memory_settings
          ADD COLUMN semantic_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE memory_candidates
          ADD COLUMN normalized_key VARCHAR(64);

        CREATE UNIQUE INDEX idx_memory_candidates_pending_normalized
          ON memory_candidates(owner_id, normalized_key)
          WHERE status = 'PENDING' AND normalized_key IS NOT NULL;

        CREATE TABLE memory_capture_states (
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_ids UUID[] NOT NULL,
          message_count INTEGER NOT NULL CHECK (message_count > 0),
          first_message_at TIMESTAMPTZ NOT NULL,
          last_message_at TIMESTAMPTZ NOT NULL,
          due_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (owner_id, conversation_id),
          CHECK (message_count = cardinality(message_ids))
        );

        CREATE TABLE memory_capture_jobs (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_ids UUID[] NOT NULL CHECK (cardinality(message_ids) > 0),
          status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
            CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          error_message VARCHAR(500),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );

        CREATE INDEX idx_memory_capture_states_due
          ON memory_capture_states(due_at, updated_at);
        CREATE INDEX idx_memory_capture_jobs_poll
          ON memory_capture_jobs(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 4,
    name: "add_assistant_retrieval_tools",
    async up(client) {
      await client.query(`
        CREATE TABLE assistant_tool_grants (
          assistant_id UUID PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          cross_conversation_search BOOLEAN NOT NULL DEFAULT FALSE,
          private_memory_read BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (assistant_id, owner_id)
        );

        INSERT INTO assistant_tool_grants (assistant_id, owner_id)
        SELECT id, owner_id FROM ai_assistants
        ON CONFLICT (assistant_id) DO NOTHING;

        CREATE TABLE ai_assistant_message_context_sources (
          message_id UUID NOT NULL REFERENCES ai_assistant_messages(id) ON DELETE CASCADE,
          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('MESSAGE', 'MEMORY')),
          source_id UUID NOT NULL,
          conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          target_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
          citation VARCHAR(24) NOT NULL,
          label VARCHAR(180) NOT NULL,
          excerpt TEXT NOT NULL,
          source_created_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, source_type, source_id)
        );

        CREATE INDEX idx_assistant_context_sources_target_message
          ON ai_assistant_message_context_sources(target_message_id)
          WHERE target_message_id IS NOT NULL;
        CREATE INDEX idx_assistant_context_sources_source
          ON ai_assistant_message_context_sources(source_type, source_id);
      `);
    },
  },
  {
    version: 5,
    name: "add_chat_assistant_invocations",
    async up(client) {
      await client.query(`
        CREATE TABLE assistant_invocations (
          id UUID PRIMARY KEY,
          requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assistant_id UUID NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          assistant_name VARCHAR(80) NOT NULL,
          assistant_avatar_color VARCHAR(20) NOT NULL,
          mode VARCHAR(24) NOT NULL DEFAULT 'PRIVATE_PREVIEW'
            CHECK (mode IN ('PRIVATE_PREVIEW', 'CONVERSATION_REPLY')),
          status VARCHAR(24) NOT NULL DEFAULT 'QUEUED'
            CHECK (status IN (
              'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED'
            )),
          prompt TEXT NOT NULL,
          result_text TEXT,
          error_message VARCHAR(500),
          model_id UUID REFERENCES ai_model_configs(id) ON DELETE SET NULL,
          result_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          dismissed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (requester_id, source_message_id, assistant_id)
        );

        ALTER TABLE messages
          ADD COLUMN actor_type VARCHAR(16) NOT NULL DEFAULT 'USER';
        ALTER TABLE messages
          ADD COLUMN actor_assistant_id UUID REFERENCES ai_assistants(id) ON DELETE SET NULL;
        ALTER TABLE messages
          ADD COLUMN actor_name VARCHAR(80);
        ALTER TABLE messages
          ADD COLUMN actor_avatar_color VARCHAR(20);
        ALTER TABLE messages
          ADD COLUMN invocation_id UUID REFERENCES assistant_invocations(id) ON DELETE SET NULL;
        ALTER TABLE messages
          ADD CONSTRAINT messages_actor_type_check CHECK (actor_type IN ('USER', 'ASSISTANT'));
        ALTER TABLE messages
          ADD CONSTRAINT messages_actor_shape_check CHECK (
            (actor_type = 'USER' AND actor_name IS NULL AND actor_avatar_color IS NULL)
            OR
            (actor_type = 'ASSISTANT' AND actor_name IS NOT NULL AND actor_avatar_color IS NOT NULL)
          );

        CREATE UNIQUE INDEX idx_messages_invocation
          ON messages(invocation_id) WHERE invocation_id IS NOT NULL;
        CREATE INDEX idx_assistant_invocations_requester_active
          ON assistant_invocations(requester_id, conversation_id, updated_at DESC)
          WHERE dismissed_at IS NULL AND status <> 'SUCCEEDED';
        CREATE INDEX idx_assistant_invocations_worker
          ON assistant_invocations(status, created_at)
          WHERE status IN ('QUEUED', 'RUNNING');
      `);
    },
  },
];

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
