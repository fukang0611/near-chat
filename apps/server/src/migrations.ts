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
  {
    version: 6,
    name: "create_personal_sync_and_connector_domains",
    async up(client) {
      await client.query(`
        CREATE TABLE personal_tasks (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(160) NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          due_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE personal_reminders (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(160) NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          scheduled_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          notified_at TIMESTAMPTZ,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE personal_records (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(160) NOT NULL,
          content TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX idx_personal_tasks_owner ON personal_tasks(owner_id, completed_at, updated_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX idx_personal_reminders_owner ON personal_reminders(owner_id, scheduled_at) WHERE deleted_at IS NULL;
        CREATE INDEX idx_personal_records_owner ON personal_records(owner_id, updated_at DESC) WHERE deleted_at IS NULL;

        CREATE TABLE sync_devices (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          installation_id UUID NOT NULL,
          name VARCHAR(120) NOT NULL,
          platform VARCHAR(32) NOT NULL,
          app_version VARCHAR(40) NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(owner_id, installation_id)
        );
        CREATE TABLE sync_entity_snapshots (
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          entity_type VARCHAR(32) NOT NULL CHECK (entity_type IN (
            'MEMORY', 'PERSONAL_TASK', 'PERSONAL_REMINDER', 'PERSONAL_RECORD',
            'ASSISTANT', 'ASSISTANT_THREAD', 'ASSISTANT_MESSAGE'
          )),
          entity_id UUID NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          deleted_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(owner_id, entity_type, entity_id)
        );
        CREATE TABLE sync_operations (
          operation_id UUID PRIMARY KEY,
          device_id UUID NOT NULL REFERENCES sync_devices(id) ON DELETE CASCADE,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          entity_type VARCHAR(32) NOT NULL,
          entity_id UUID NOT NULL,
          operation VARCHAR(12) NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
          base_revision INTEGER,
          outcome JSONB NOT NULL,
          device_created_at TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE sync_changes (
          sequence BIGSERIAL PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          entity_type VARCHAR(32) NOT NULL,
          entity_id UUID NOT NULL,
          operation VARCHAR(12) NOT NULL CHECK (operation IN ('UPSERT', 'DELETE')),
          revision INTEGER NOT NULL,
          payload JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE sync_cursors (
          device_id UUID PRIMARY KEY REFERENCES sync_devices(id) ON DELETE CASCADE,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_sequence BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX idx_sync_changes_owner_sequence ON sync_changes(owner_id, sequence);
        CREATE INDEX idx_sync_snapshots_owner ON sync_entity_snapshots(owner_id, updated_at DESC);

        CREATE TABLE connector_configs (
          id UUID PRIMARY KEY,
          provider VARCHAR(32) NOT NULL CHECK (provider IN ('DINGTALK_STREAM', 'WECOM_WEBHOOK', 'WECOM_CALLBACK')),
          name VARCHAR(120) NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          config_encrypted TEXT NOT NULL,
          created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE connector_events (
          id UUID PRIMARY KEY,
          connector_id UUID NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
          external_event_id VARCHAR(200) NOT NULL,
          payload JSONB NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED')),
          error_message VARCHAR(500),
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ,
          UNIQUE(connector_id, external_event_id)
        );
        CREATE TABLE connector_delivery_jobs (
          id UUID PRIMARY KEY,
          connector_id UUID NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
          kind VARCHAR(40) NOT NULL,
          payload JSONB NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          error_message VARCHAR(500),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX idx_connector_delivery_jobs_poll ON connector_delivery_jobs(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 7,
    name: "harden_sync_and_connector_delivery",
    async up(client) {
      await client.query(`
        ALTER TABLE ai_assistants
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          ADD COLUMN deleted_at TIMESTAMPTZ;
        ALTER TABLE ai_assistant_threads
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          ADD COLUMN deleted_at TIMESTAMPTZ;
        ALTER TABLE ai_assistant_messages
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          ADD COLUMN deleted_at TIMESTAMPTZ;

        DROP INDEX IF EXISTS idx_ai_assistant_threads_default;
        CREATE UNIQUE INDEX idx_ai_assistant_threads_default
          ON ai_assistant_threads(assistant_id)
          WHERE is_default = TRUE AND deleted_at IS NULL;
        CREATE INDEX idx_ai_assistants_owner_sync
          ON ai_assistants(owner_id, updated_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX idx_ai_assistant_threads_owner_sync
          ON ai_assistant_threads(owner_id, assistant_id, updated_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX idx_ai_assistant_messages_thread_sync
          ON ai_assistant_messages(thread_id, created_at, id) WHERE deleted_at IS NULL;

        ALTER TABLE sync_operations DROP CONSTRAINT sync_operations_pkey;
        ALTER TABLE sync_operations
          ADD COLUMN request_fingerprint VARCHAR(64),
          ADD CONSTRAINT sync_operations_pkey PRIMARY KEY(owner_id, operation_id),
          ADD CONSTRAINT sync_operations_request_fingerprint_check
            CHECK (request_fingerprint IS NULL OR char_length(request_fingerprint) = 64);
        CREATE UNIQUE INDEX uq_sync_changes_entity_revision
          ON sync_changes(owner_id, entity_type, entity_id, revision);

        CREATE TABLE memory_sync_conflicts (
          id UUID PRIMARY KEY,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          operation_id UUID NOT NULL,
          base_revision INTEGER,
          server_revision INTEGER NOT NULL CHECK (server_revision > 0),
          incoming_payload JSONB NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'RESOLVED', 'DISMISSED')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ,
          UNIQUE(owner_id, operation_id)
        );
        CREATE INDEX idx_memory_sync_conflicts_pending
          ON memory_sync_conflicts(owner_id, status, created_at DESC)
          WHERE status = 'PENDING';
        CREATE INDEX idx_sync_snapshots_tombstones
          ON sync_entity_snapshots(deleted_at) WHERE deleted_at IS NOT NULL;
        CREATE INDEX idx_personal_tasks_tombstones
          ON personal_tasks(deleted_at) WHERE deleted_at IS NOT NULL;
        CREATE INDEX idx_personal_reminders_tombstones
          ON personal_reminders(deleted_at) WHERE deleted_at IS NOT NULL;
        CREATE INDEX idx_personal_records_tombstones
          ON personal_records(deleted_at) WHERE deleted_at IS NOT NULL;

        ALTER TABLE connector_configs
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          ADD COLUMN last_error VARCHAR(500),
          ADD COLUMN started_at TIMESTAMPTZ;

        ALTER TABLE connector_events
          DROP CONSTRAINT IF EXISTS connector_events_status_check;
        ALTER TABLE connector_events
          ADD COLUMN event_kind VARCHAR(80) NOT NULL DEFAULT 'UNKNOWN',
          ADD COLUMN external_conversation_id VARCHAR(200),
          ADD COLUMN external_user_id VARCHAR(200),
          ADD COLUMN result JSONB NOT NULL DEFAULT '{}'::jsonb,
          ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN lease_expires_at TIMESTAMPTZ,
          ADD CONSTRAINT connector_events_status_check
            CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED'));
        CREATE INDEX idx_connector_events_poll
          ON connector_events(status, next_attempt_at, received_at);

        ALTER TABLE connector_delivery_jobs
          ADD COLUMN idempotency_key VARCHAR(200),
          ADD COLUMN lease_expires_at TIMESTAMPTZ;
        UPDATE connector_delivery_jobs
           SET idempotency_key = id::text
         WHERE idempotency_key IS NULL;
        ALTER TABLE connector_delivery_jobs
          ALTER COLUMN idempotency_key SET NOT NULL;
        CREATE UNIQUE INDEX idx_connector_delivery_idempotency
          ON connector_delivery_jobs(connector_id, idempotency_key);

        CREATE TABLE connector_identities (
          id UUID PRIMARY KEY,
          connector_id UUID NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
          external_user_id VARCHAR(200) NOT NULL,
          near_chat_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          display_name VARCHAR(160) NOT NULL DEFAULT '',
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(connector_id, external_user_id)
        );

        CREATE TABLE connector_bindings (
          id UUID PRIMARY KEY,
          connector_id UUID NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          external_conversation_id VARCHAR(200) NOT NULL,
          near_chat_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
          assistant_id UUID REFERENCES ai_assistants(id) ON DELETE SET NULL,
          delivery_kinds VARCHAR(40)[] NOT NULL DEFAULT '{}'::varchar[],
          delivery_target_encrypted TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(connector_id, external_conversation_id),
          CHECK (delivery_kinds <@ ARRAY['TASK_RESULT','REMINDER','SUMMARY','TEXT']::varchar[])
        );
        CREATE INDEX idx_connector_bindings_owner
          ON connector_bindings(owner_id, enabled, updated_at DESC);

        CREATE TABLE connector_message_links (
          id UUID PRIMARY KEY,
          connector_id UUID NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
          external_message_id VARCHAR(200) NOT NULL,
          near_chat_message_id UUID,
          direction VARCHAR(12) NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
          event_id UUID REFERENCES connector_events(id) ON DELETE SET NULL,
          delivery_job_id UUID REFERENCES connector_delivery_jobs(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(connector_id, external_message_id, direction)
        );
        CREATE INDEX idx_connector_message_links_near_chat
          ON connector_message_links(near_chat_message_id)
          WHERE near_chat_message_id IS NOT NULL;
      `);
    },
  },
  {
    version: 8,
    name: "harden_connector_operations_and_message_idempotency",
    async up(client) {
      await client.query(`
        ALTER TABLE ai_assistant_messages
          ADD COLUMN connector_event_id UUID
            REFERENCES connector_events(id) ON DELETE SET NULL;
        CREATE UNIQUE INDEX uq_ai_assistant_messages_connector_event_role
          ON ai_assistant_messages(connector_event_id, role)
          WHERE connector_event_id IS NOT NULL;

        ALTER TABLE connector_bindings
          ADD COLUMN delivery_target_expires_at TIMESTAMPTZ;

        ALTER TABLE connector_events
          DROP CONSTRAINT IF EXISTS connector_events_status_check;
        ALTER TABLE connector_events
          ADD CONSTRAINT connector_events_status_check
            CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED'));

        ALTER TABLE connector_delivery_jobs
          DROP CONSTRAINT IF EXISTS connector_delivery_jobs_status_check;
        ALTER TABLE connector_delivery_jobs
          ADD CONSTRAINT connector_delivery_jobs_status_check
            CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));

        CREATE INDEX idx_connector_events_operations
          ON connector_events(status, received_at DESC, id DESC);
        CREATE INDEX idx_connector_delivery_jobs_operations
          ON connector_delivery_jobs(status, updated_at DESC, id DESC);
      `);
    },
  },
  {
    version: 9,
    name: "minimize_memory_sync_tombstones",
    async up(client) {
      await client.query(`
        UPDATE sync_entity_snapshots
           SET payload = jsonb_build_object(
             'id', entity_id,
             'revision', revision,
             'deletedAt', CASE
               WHEN jsonb_typeof(payload->'deletedAt') = 'string' THEN payload->'deletedAt'
               ELSE to_jsonb(deleted_at)
             END
           )
         WHERE entity_type = 'MEMORY'
           AND deleted_at IS NOT NULL;

        UPDATE sync_changes
           SET payload = jsonb_build_object(
             'id', entity_id,
             'revision', revision,
             'deletedAt', CASE
               WHEN jsonb_typeof(payload->'deletedAt') = 'string' THEN payload->'deletedAt'
               ELSE to_jsonb(occurred_at)
             END
           )
         WHERE entity_type = 'MEMORY'
           AND operation = 'DELETE';

        UPDATE sync_operations
           SET outcome = jsonb_set(
             outcome,
             '{applied,payload}',
             jsonb_build_object(
               'id', entity_id,
               'revision', COALESCE(
                 outcome #> '{applied,revision}',
                 outcome #> '{applied,payload,revision}'
               ),
               'deletedAt', CASE
                 WHEN jsonb_typeof(outcome #> '{applied,payload,deletedAt}') = 'string'
                   THEN outcome #> '{applied,payload,deletedAt}'
                 ELSE COALESCE(
                   outcome #> '{applied,occurredAt}',
                   to_jsonb(received_at)
                 )
               END
             ),
             true
           )
         WHERE entity_type = 'MEMORY'
           AND operation = 'DELETE'
           AND jsonb_typeof(outcome->'applied') = 'object';
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
