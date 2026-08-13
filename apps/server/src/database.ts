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

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  type VARCHAR(20) NOT NULL DEFAULT 'DIRECT' CHECK (type IN ('DIRECT', 'GROUP')),
  direct_key TEXT UNIQUE,
  name VARCHAR(80),
  avatar_color VARCHAR(20) NOT NULL DEFAULT '#5B6EE1',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
  type VARCHAR(20) NOT NULL CHECK (type IN ('TEXT', 'IMAGE', 'FILE')),
  text_content TEXT,
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  recalled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sender_id, client_message_id)
);

-- 增量升级旧数据库：引用和撤回字段均允许为空，不影响现有历史消息。
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;

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
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX IF NOT EXISTS idx_attachments_orphan_cleanup
  ON attachments(state, created_at) WHERE message_id IS NULL;
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
