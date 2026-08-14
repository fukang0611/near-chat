import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// 同时兼容工作区根目录启动和 apps/server 目录启动两种开发方式。
dotenv.config({ path: path.resolve(currentDir, "../../../.env") });
dotenv.config();

function integer(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(name: string, fallback: number): number {
  const value = integer(name, fallback);
  return value > 0 ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export const config = {
  port: integer("APP_PORT", 3000),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://near_chat:near_chat@localhost:5432/near_chat",
  jwtSecret: process.env.JWT_SECRET ?? "near-chat-local-dev-secret-change-before-sharing",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  // 管理后台保存的模型密钥使用独立密钥加密；未配置时兼容性回退到 JWT 密钥。
  aiSettingsEncryptionKey:
    process.env.AI_SETTINGS_ENCRYPTION_KEY ??
    process.env.JWT_SECRET ??
    "near-chat-local-dev-secret-change-before-sharing",
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: integer("MINIO_PORT", 9000),
    useSSL: bool("MINIO_USE_SSL", false),
    accessKey: process.env.MINIO_ACCESS_KEY ?? "near-chat",
    secretKey: process.env.MINIO_SECRET_KEY ?? "near-chat-secret",
    bucket: process.env.MINIO_BUCKET ?? "near-chat-files",
  },
  fileMaxBytes: positiveInteger("FILE_MAX_BYTES", 50 * 1024 * 1024),
  avatarMaxBytes: positiveInteger("AVATAR_MAX_BYTES", 8 * 1024 * 1024),
  // 配额统计包含已发送附件和仍在等待发送的附件，避免上传后再校验导致超额。
  fileUserQuotaBytes: positiveInteger("FILE_USER_QUOTA_BYTES", 1024 * 1024 * 1024),
  fileOrphanTtlHours: positiveInteger("FILE_ORPHAN_TTL_HOURS", 24),
  fileCleanupIntervalMinutes: positiveInteger("FILE_CLEANUP_INTERVAL_MINUTES", 30),
  storageRetryAttempts: positiveInteger("STORAGE_RETRY_ATTEMPTS", 3),
  // 第一阶段采用简洁的发送者撤回规则，部署时可按组织要求调整时限。
  messageRecallWindowSeconds: positiveInteger("MESSAGE_RECALL_WINDOW_SECONDS", 120),
  seedDemoUsers: bool("SEED_DEMO_USERS", true),
  seedPasswords: {
    admin: process.env.SEED_ADMIN_PASSWORD ?? "admin123",
    alice: process.env.SEED_ALICE_PASSWORD ?? "alice123",
    bob: process.env.SEED_BOB_PASSWORD ?? "bob123",
  },
  /**
   * 这些环境变量仅用于数据库第一次创建 AI 设置时的引导值。之后管理员可在
   * 管理中心热更新配置，服务重启不会用环境变量覆盖已经保存的设置。
   */
  ai: {
    enabled: bool("AI_ENABLED", false),
    sharedBaseUrl: process.env.AI_BASE_URL?.trim() || undefined,
    sharedApiKey: process.env.AI_API_KEY?.trim() || undefined,
    chat: {
      baseUrl: process.env.AI_CHAT_BASE_URL?.trim() || undefined,
      apiKey: process.env.AI_CHAT_API_KEY?.trim() || undefined,
      model: process.env.AI_CHAT_MODEL?.trim() || undefined,
    },
    embedding: {
      baseUrl: process.env.AI_EMBEDDING_BASE_URL?.trim() || undefined,
      apiKey: process.env.AI_EMBEDDING_API_KEY?.trim() || undefined,
      model: process.env.AI_EMBEDDING_MODEL?.trim() || undefined,
      dimensions: positiveInteger("AI_EMBEDDING_DIMENSIONS", 1536),
    },
    knowledge: {
      chunkSize: positiveInteger("AI_KNOWLEDGE_CHUNK_SIZE", 1200),
      chunkOverlap: positiveInteger("AI_KNOWLEDGE_CHUNK_OVERLAP", 180),
      maxExtractedChars: positiveInteger("AI_KNOWLEDGE_MAX_EXTRACTED_CHARS", 2_000_000),
      maxChunks: positiveInteger("AI_KNOWLEDGE_MAX_CHUNKS", 1000),
      pollMs: positiveInteger("AI_KNOWLEDGE_POLL_MS", 3000),
      defaultTopK: positiveInteger("AI_KNOWLEDGE_TOP_K", 8),
    },
  },
};
