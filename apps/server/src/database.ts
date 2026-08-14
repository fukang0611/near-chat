import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";
import { retryUntilReady } from "./retry.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// PostgreSQL 重启时可能主动中断池中的空闲连接。监听池级错误可避免 Node
// 把这种可恢复的基础设施波动当成未捕获异常并直接退出进程。
pool.on("error", (error) => {
  console.error("PostgreSQL pool connection interrupted:", error.message);
});

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_color VARCHAR(20) NOT NULL DEFAULT '#6C5CE7',
  avatar_bucket TEXT,
  avatar_object_key TEXT,
  avatar_content_type VARCHAR(50),
  avatar_size_bytes BIGINT,
  avatar_version INTEGER NOT NULL DEFAULT 0,
  status_text VARCHAR(40),
  status_emoji VARCHAR(16),
  status_expires_at TIMESTAMPTZ,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 自定义头像独立于聊天附件；增量字段兼容已有第一阶段数据库。
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_bucket TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_object_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_content_type VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_size_bytes BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_avatar_object_key
  ON users(avatar_object_key) WHERE avatar_object_key IS NOT NULL;

-- 限时状态是用户资料的一部分，不写入消息表；过期后查询层会自动隐藏。
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  type VARCHAR(20) NOT NULL DEFAULT 'DIRECT' CHECK (type IN ('DIRECT', 'GROUP')),
  direct_key TEXT UNIQUE,
  name VARCHAR(80),
  avatar_color VARCHAR(20) NOT NULL DEFAULT '#5B6EE1',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 兼容第一阶段已经创建的数据库：旧表只允许单聊，且 direct_key 不可为空。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name VARCHAR(80);
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(20) NOT NULL DEFAULT '#5B6EE1';
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE conversations ALTER COLUMN direct_key DROP NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_type_check CHECK (type IN ('DIRECT', 'GROUP'));

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  client_message_id UUID NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('TEXT', 'IMAGE', 'AUDIO', 'FILE')),
  text_content TEXT,
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from JSONB,
  recalled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sender_id, client_message_id)
);

-- 增量升级旧数据库：引用和撤回字段均允许为空，不影响现有历史消息。
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from JSONB;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_type_check CHECK (type IN ('TEXT', 'IMAGE', 'AUDIO', 'FILE'));

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY,
  uploader_id UUID NOT NULL REFERENCES users(id),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  bucket_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'READY'
    CHECK (state IN ('PENDING', 'READY', 'CLEANING', 'CLEANUP_FAILED')),
  state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 历史附件在升级前已经完整写入 MinIO，因此直接视为 READY。
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS state VARCHAR(20) NOT NULL DEFAULT 'READY';
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_state_check;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_state_check
  CHECK (state IN ('PENDING', 'READY', 'CLEANING', 'CLEANUP_FAILED'));

-- 附件可以被收藏长期引用；原消息删除时只解除归属，真正回收由引用检查决定。
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_message_id_fkey;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS message_favorites (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_conversation_title VARCHAR(80) NOT NULL,
  source_sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_sender_name VARCHAR(80) NOT NULL,
  source_sender_avatar_color VARCHAR(20) NOT NULL,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('TEXT', 'IMAGE', 'AUDIO', 'FILE')),
  text_content TEXT,
  forwarded_from JSONB,
  message_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_favorites_user_source
  ON message_favorites(user_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS favorite_attachments (
  favorite_id UUID NOT NULL REFERENCES message_favorites(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (favorite_id, attachment_id)
);

-- 转发消息复用原附件对象，只新增目标消息到附件的引用关系。
CREATE TABLE IF NOT EXISTS message_attachment_links (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

ALTER TABLE message_favorites ADD COLUMN IF NOT EXISTS forwarded_from JSONB;

-- NearChat 原生知识库保留业务权限与文件关系；Mastra/pgvector 只保存可重建的向量。
-- 第一阶段知识库归创建者私有，后续共享权限可以在不改文档模型的前提下扩展。
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(240) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  added_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(240) NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'INDEXING', 'READY', 'FAILED')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_base_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text_content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, position)
);

-- 删除文档后向量清理任务仍须存活，因此 document_id 有意不设置外键。
CREATE TABLE IF NOT EXISTS knowledge_index_jobs (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('INDEX', 'DELETE')),
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_active
  ON knowledge_index_jobs(document_id, action)
  WHERE status IN ('QUEUED', 'RUNNING');

-- 管理员可以维护多个 OpenAI 兼容对话模型；显示名称用于用户选择，provider_model
-- 是实际传给兼容接口的模型标识。API Key 只保存 AES-GCM 密文。
CREATE TABLE IF NOT EXISTS ai_model_configs (
  id UUID PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  base_url TEXT,
  api_key_encrypted TEXT,
  provider_model TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI 设置是整个 NearChat 实例共享的单例。Embedding 保持全局唯一，确保同一向量
-- 索引不混入不同语义空间；对话模型则通过 default_chat_model_id 指向模型目录。
-- embedding_revision 用于判断已有向量是否由当前模型生成。
CREATE TABLE IF NOT EXISTS ai_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_chat_model_id UUID REFERENCES ai_model_configs(id) ON DELETE SET NULL,
  embedding_base_url TEXT,
  embedding_api_key_encrypted TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER NOT NULL DEFAULT 1536
    CHECK (embedding_dimensions BETWEEN 1 AND 4000),
  revision INTEGER NOT NULL DEFAULT 1,
  embedding_revision INTEGER NOT NULL DEFAULT 1,
  vector_embedding_revision INTEGER NOT NULL DEFAULT 0,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 普通用户只保存一个偏好模型；模型被删除时偏好自动移除并回退到全局默认。
CREATE TABLE IF NOT EXISTS user_ai_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_model_id UUID NOT NULL REFERENCES ai_model_configs(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 个人智能助理由用户自行创建和管理。model_id 为空时跟随用户偏好或全局默认，
-- 模型被删除时自动回退，不让助理配置阻塞核心聊天功能。
CREATE TABLE IF NOT EXISTS ai_assistants (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(240) NOT NULL DEFAULT '',
  category VARCHAR(24) NOT NULL DEFAULT 'GENERAL'
    CHECK (category IN ('GENERAL', 'WRITING', 'ANALYSIS', 'PLANNING')),
  instructions TEXT NOT NULL,
  avatar_color VARCHAR(20) NOT NULL DEFAULT '#6757E8',
  model_id UUID REFERENCES ai_model_configs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 一个助理可以组合用户自己的多个知识库；知识库删除后只解除绑定。
CREATE TABLE IF NOT EXISTS ai_assistant_knowledge_bases (
  assistant_id UUID NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY (assistant_id, knowledge_base_id)
);

-- 第一阶段每个助理维护一条独立持久时间线。后续若需要多线程会话，可在本表前
-- 增加 thread_id，而不改变助理配置与模型绑定。
CREATE TABLE IF NOT EXISTS ai_assistant_messages (
  id UUID PRIMARY KEY,
  assistant_id UUID NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  role VARCHAR(12) NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
  content TEXT NOT NULL,
  model_id UUID REFERENCES ai_model_configs(id) ON DELETE SET NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 助理任务以 next_run_at 表示下一次计划执行，以 run_requested_at 表示不改变
-- 原计划的“立即执行”请求。调度状态与任务定义同表，便于列表页一次读取。
CREATE TABLE IF NOT EXISTS ai_assistant_tasks (
  id UUID PRIMARY KEY,
  assistant_id UUID NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(80) NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type VARCHAR(12) NOT NULL
    CHECK (schedule_type IN ('ONCE', 'DAILY', 'WEEKLY')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  run_requested_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_status VARCHAR(12) NOT NULL DEFAULT 'NEVER'
    CHECK (last_status IN ('NEVER', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每次执行独立留痕；任务删除时历史一并删除，清空助理对话时仅解除结果消息引用。
CREATE TABLE IF NOT EXISTS ai_assistant_task_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES ai_assistant_tasks(id) ON DELETE CASCADE,
  trigger VARCHAR(12) NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL')),
  status VARCHAR(12) NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  result_message_id UUID REFERENCES ai_assistant_messages(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 旧群聊以创建人作为群主；若创建人已删除，则回退为最早加入的成员。
UPDATE conversations conversation
   SET owner_id = COALESCE(
         conversation.created_by,
         (SELECT member.user_id
            FROM conversation_members member
           WHERE member.conversation_id = conversation.id
           ORDER BY member.joined_at, member.user_id
           LIMIT 1)
       )
 WHERE conversation.type = 'GROUP' AND conversation.owner_id IS NULL;

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

-- 为升级前的历史消息补齐回执。已被成员读过的历史消息同时视为已送达。
INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
SELECT m.id,
       cm.user_id,
       CASE WHEN m.created_at <= cm.last_read_at THEN cm.last_read_at ELSE NULL END,
       CASE WHEN m.created_at <= cm.last_read_at THEN cm.last_read_at ELSE NULL END
  FROM messages m
  JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
 WHERE cm.user_id <> m.sender_id
ON CONFLICT (message_id, user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
  ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_cursor
  ON messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX IF NOT EXISTS idx_attachments_orphan_cleanup
  ON attachments(state, created_at) WHERE message_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_message_favorites_user_created
  ON message_favorites(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_favorite_attachments_attachment
  ON favorite_attachments(attachment_id);
CREATE INDEX IF NOT EXISTS idx_message_attachment_links_attachment
  ON message_attachment_links(attachment_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_owner_updated
  ON knowledge_bases(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_base_created
  ON knowledge_documents(knowledge_base_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_attachment
  ON knowledge_documents(attachment_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_position
  ON knowledge_chunks(document_id, position);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_text_search
  ON knowledge_chunks USING GIN (to_tsvector('simple', text_content));
CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_poll
  ON knowledge_index_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_model_configs_enabled_updated
  ON ai_model_configs(enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_assistants_owner_activity
  ON ai_assistants(owner_id, updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_assistant_messages_timeline
  ON ai_assistant_messages(assistant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_ai_assistant_tasks_assistant_updated
  ON ai_assistant_tasks(assistant_id, updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_assistant_tasks_due
  ON ai_assistant_tasks(next_run_at, run_requested_at)
  WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_ai_assistant_tasks_requested
  ON ai_assistant_tasks(run_requested_at) WHERE run_requested_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_assistant_task_runs_history
  ON ai_assistant_task_runs(task_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_assistant_task_runs_running
  ON ai_assistant_task_runs(started_at) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS idx_receipts_user_pending
  ON message_receipts(user_id, delivered_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_message ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
`;

const seedUsers = [
  {
    username: "admin",
    displayName: "管理员",
    role: "ADMIN",
    color: "#6757E8",
    password: config.seedPasswords.admin,
  },
  {
    username: "alice",
    displayName: "林小满",
    role: "USER",
    color: "#E76F88",
    password: config.seedPasswords.alice,
  },
  {
    username: "bob",
    displayName: "周远",
    role: "USER",
    color: "#2FA98C",
    password: config.seedPasswords.bob,
  },
] as const;

export async function initializeDatabase(): Promise<void> {
  await retryUntilReady(() => pool.query("SELECT 1"));

  await pool.query(schema);

  // 种子账号只在首次启动时写入，已有账号的密码和资料不会被容器重启覆盖。
  const usersToSeed = config.seedDemoUsers
    ? seedUsers
    : seedUsers.filter((user) => user.username === "admin");
  for (const user of usersToSeed) {
    const passwordHash = await bcrypt.hash(user.password, 10);
    await pool.query(
      `INSERT INTO users
         (id, username, display_name, password_hash, role, avatar_color)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING`,
      [randomUUID(), user.username, user.displayName, passwordHash, user.role, user.color],
    );
  }
}
