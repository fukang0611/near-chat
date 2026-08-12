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
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: integer("MINIO_PORT", 9000),
    useSSL: bool("MINIO_USE_SSL", false),
    accessKey: process.env.MINIO_ACCESS_KEY ?? "near-chat",
    secretKey: process.env.MINIO_SECRET_KEY ?? "near-chat-secret",
    bucket: process.env.MINIO_BUCKET ?? "near-chat-files",
  },
  fileMaxBytes: positiveInteger("FILE_MAX_BYTES", 50 * 1024 * 1024),
  // 配额统计包含已发送附件和仍在等待发送的附件，避免上传后再校验导致超额。
  fileUserQuotaBytes: positiveInteger("FILE_USER_QUOTA_BYTES", 1024 * 1024 * 1024),
  fileOrphanTtlHours: positiveInteger("FILE_ORPHAN_TTL_HOURS", 24),
  fileCleanupIntervalMinutes: positiveInteger("FILE_CLEANUP_INTERVAL_MINUTES", 30),
  storageRetryAttempts: positiveInteger("STORAGE_RETRY_ATTEMPTS", 3),
  seedDemoUsers: bool("SEED_DEMO_USERS", true),
  seedPasswords: {
    admin: process.env.SEED_ADMIN_PASSWORD ?? "admin123",
    alice: process.env.SEED_ALICE_PASSWORD ?? "alice123",
    bob: process.env.SEED_BOB_PASSWORD ?? "bob123",
  },
};
