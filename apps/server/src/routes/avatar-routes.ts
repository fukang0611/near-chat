import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { recordAudit } from "../audit-service.js";
import { authenticate, toAuthUser, type AuthUserRow } from "../auth.js";
import { avatarExtension, detectAvatarContentType } from "../avatar-service.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser, publicUser } from "../http.js";
import { minio } from "../minio.js";
import { RealtimeHub } from "../realtime.js";
import { retryOperation } from "../retry.js";

interface AvatarStorageRow {
  avatar_bucket: string | null;
  avatar_object_key: string | null;
  avatar_content_type: string | null;
  avatar_size_bytes: string | null;
}

interface PublicAvatarRow extends AvatarStorageRow {
  enabled: boolean;
}

const authUserColumns = `
  id, username, display_name, role, enabled, avatar_color,
  avatar_object_key, avatar_version, token_version
`;

async function removeAvatarObject(bucket: string | null, objectKey: string | null): Promise<void> {
  if (!bucket || !objectKey) return;
  await retryOperation(() => minio.removeObject(bucket, objectKey), {
    attempts: config.storageRetryAttempts,
    delayMs: 350,
  });
}

function reportCleanupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Avatar object cleanup failed: ${message}`);
}

/** 自定义头像保留原始图片字节，GIF 因此可以原样播放，不经过破坏动画的转码。 */
export function createAvatarRouter(realtime: RealtimeHub) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.avatarMaxBytes, files: 1 },
  });

  // 头像属于公开资料，img 标签无需携带 Authorization 即可直接显示。
  router.get("/users/:userId/avatar", async (request, response) => {
    const userId = z.string().uuid().parse(request.params.userId);
    const result = await query<PublicAvatarRow>(
      `SELECT enabled, avatar_bucket, avatar_object_key, avatar_content_type,
              avatar_size_bytes::text
         FROM users
        WHERE id = $1`,
      [userId],
    );
    const avatar = result.rows[0];
    if (
      !avatar?.enabled ||
      !avatar.avatar_bucket ||
      !avatar.avatar_object_key ||
      !avatar.avatar_content_type ||
      !avatar.avatar_size_bytes
    ) {
      throw new ApiError(404, "头像不存在");
    }

    try {
      const stream = await retryOperation(
        () => minio.getObject(avatar.avatar_bucket!, avatar.avatar_object_key!),
        { attempts: config.storageRetryAttempts, delayMs: 250 },
      );
      response.setHeader("Content-Type", avatar.avatar_content_type);
      response.setHeader("Content-Length", avatar.avatar_size_bytes);
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", "inline");
      stream.on("error", (error) => response.destroy(error));
      stream.pipe(response);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NotFound") throw new ApiError(404, "头像不存在");
      throw error;
    }
  });

  router.post("/auth/avatar", authenticate, upload.single("avatar"), async (request, response) => {
    const user = currentUser(request);
    if (!request.file) throw new ApiError(400, "请选择头像图片");

    const contentType = detectAvatarContentType(request.file.buffer);
    if (!contentType) {
      throw new ApiError(400, "头像仅支持 GIF、PNG、JPG 和 WebP 图片");
    }

    const objectKey = `avatars/${user.id}/${randomUUID()}.${avatarExtension(contentType)}`;
    await retryOperation(
      () =>
        minio.putObject(config.minio.bucket, objectKey, request.file!.buffer, request.file!.size, {
          "Content-Type": contentType,
        }),
      { attempts: config.storageRetryAttempts, delayMs: 350 },
    );

    let result: {
      user: ReturnType<typeof toAuthUser>;
      previousBucket: string | null;
      previousObjectKey: string | null;
    };
    try {
      result = await transaction(async (client) => {
        const previous = await client.query<AvatarStorageRow>(
          `SELECT avatar_bucket, avatar_object_key, avatar_content_type,
                    avatar_size_bytes::text
               FROM users
              WHERE id = $1
              FOR UPDATE`,
          [user.id],
        );
        if (!previous.rows[0]) throw new ApiError(404, "用户不存在");

        const updated = await client.query<AuthUserRow>(
          `UPDATE users
                SET avatar_bucket = $2,
                    avatar_object_key = $3,
                    avatar_content_type = $4,
                    avatar_size_bytes = $5,
                    avatar_version = avatar_version + 1,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING ${authUserColumns}`,
          [user.id, config.minio.bucket, objectKey, contentType, request.file!.size],
        );
        await recordAudit(
          {
            actorId: user.id,
            action: "AVATAR_UPDATE",
            targetType: "USER",
            targetId: user.id,
            details: { contentType, sizeBytes: request.file!.size },
          },
          client,
        );
        return {
          user: toAuthUser(updated.rows[0]),
          previousBucket: previous.rows[0].avatar_bucket,
          previousObjectKey: previous.rows[0].avatar_object_key,
        };
      });
    } catch (error) {
      await removeAvatarObject(config.minio.bucket, objectKey).catch(reportCleanupFailure);
      throw error;
    }

    await removeAvatarObject(result.previousBucket, result.previousObjectKey).catch(
      reportCleanupFailure,
    );
    realtime.sendToUsers(realtime.onlineUserIds(), {
      type: "users.changed",
      payload: { userId: user.id },
    });
    response.status(201).json({ user: publicUser(result.user) });
  });

  router.delete("/auth/avatar", authenticate, async (request, response) => {
    const user = currentUser(request);
    const result = await transaction(async (client) => {
      const current = await client.query<AuthUserRow & AvatarStorageRow>(
        `SELECT ${authUserColumns}, avatar_bucket, avatar_content_type,
                avatar_size_bytes::text
           FROM users
          WHERE id = $1
          FOR UPDATE`,
        [user.id],
      );
      const row = current.rows[0];
      if (!row) throw new ApiError(404, "用户不存在");
      if (!row.avatar_object_key) {
        return { user: toAuthUser(row), bucket: null, objectKey: null };
      }

      const updated = await client.query<AuthUserRow>(
        `UPDATE users
            SET avatar_bucket = NULL,
                avatar_object_key = NULL,
                avatar_content_type = NULL,
                avatar_size_bytes = NULL,
                avatar_version = avatar_version + 1,
                updated_at = NOW()
          WHERE id = $1
          RETURNING ${authUserColumns}`,
        [user.id],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: "AVATAR_REMOVE",
          targetType: "USER",
          targetId: user.id,
        },
        client,
      );
      return {
        user: toAuthUser(updated.rows[0]),
        bucket: row.avatar_bucket,
        objectKey: row.avatar_object_key,
      };
    });

    await removeAvatarObject(result.bucket, result.objectKey).catch(reportCleanupFailure);
    realtime.sendToUsers(realtime.onlineUserIds(), {
      type: "users.changed",
      payload: { userId: user.id },
    });
    response.json({ user: publicUser(result.user) });
  });

  return router;
}
