import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { minio } from "../minio.js";
import { removeAttachmentObject } from "../attachment-cleanup.js";
import { retryOperation } from "../retry.js";

interface AttachmentRow {
  id: string;
  uploader_id: string;
  message_id: string | null;
  bucket_name: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: string;
  state: "PENDING" | "READY" | "CLEANING" | "CLEANUP_FAILED";
}

function safeFileName(name: string): string {
  // Busboy 按 latin1 暴露 multipart 文件名，而浏览器实际发送 UTF-8 字节。
  // 仅在所有字符都可还原为单字节时尝试解码，避免破坏本来就正确的 Unicode。
  const decoded = [...name].every((character) => character.codePointAt(0)! <= 255)
    ? Buffer.from(name, "latin1").toString("utf8")
    : name;
  const normalized = decoded.includes("�") ? name : decoded;
  return (
    path
      .basename(normalized.replaceAll("\\", "/"))
      .replace(/[\r\n]/g, "_")
      .slice(0, 240) || "file"
  );
}

async function findAttachment(fileId: string): Promise<AttachmentRow | null> {
  const result = await query<AttachmentRow>(
    `SELECT id, uploader_id, message_id, bucket_name, object_key,
            original_name, content_type, size_bytes, state
       FROM attachments
      WHERE id = $1`,
    [fileId],
  );
  return result.rows[0] ?? null;
}

/** 图片与普通附件共享同一套私有对象访问规则。 */
export function createFileRouter() {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.fileMaxBytes, files: 1 },
  });

  router.post("/files", authenticate, upload.single("file"), async (request, response) => {
    const user = currentUser(request);
    if (!request.file) throw new ApiError(400, "请选择文件");
    const uploadedFile = request.file;

    const attachmentId = randomUUID();
    const now = new Date();
    const objectKey = [
      user.id,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      attachmentId,
    ].join("/");
    const originalName = safeFileName(uploadedFile.originalname);
    const contentType = uploadedFile.mimetype || "application/octet-stream";

    // 用户级事务锁让并发上传的配额检查和预留保持原子性。
    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
      const usage = await client.query<{ used_bytes: string }>(
        `SELECT COALESCE(SUM(size_bytes), 0)::text AS used_bytes
           FROM attachments
          WHERE uploader_id = $1`,
        [user.id],
      );
      const usedBytes = Number(usage.rows[0]?.used_bytes ?? 0);
      if (usedBytes + uploadedFile.size > config.fileUserQuotaBytes) {
        const remainingMb = Math.max(
          0,
          Math.floor((config.fileUserQuotaBytes - usedBytes) / 1024 / 1024),
        );
        throw new ApiError(413, `个人文件空间不足，当前剩余约 ${remainingMb} MB`);
      }
      await client.query(
        `INSERT INTO attachments
             (id, uploader_id, bucket_name, object_key, original_name,
              content_type, size_bytes, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
        [
          attachmentId,
          user.id,
          config.minio.bucket,
          objectKey,
          originalName,
          contentType,
          uploadedFile.size,
        ],
      );
    });

    try {
      await retryOperation(
        () =>
          minio.putObject(config.minio.bucket, objectKey, uploadedFile.buffer, uploadedFile.size, {
            "Content-Type": contentType,
          }),
        { attempts: config.storageRetryAttempts, delayMs: 500 },
      );
      await query(
        `UPDATE attachments
            SET state = 'READY', state_updated_at = NOW()
          WHERE id = $1`,
        [attachmentId],
      );
    } catch (error) {
      // 失败记录交给清理器继续重试，避免对象已写入但元数据丢失。
      await query(
        `UPDATE attachments
            SET state = 'CLEANUP_FAILED', state_updated_at = NOW()
          WHERE id = $1`,
        [attachmentId],
      ).catch(() => undefined);
      await removeAttachmentObject({
        id: attachmentId,
        bucket_name: config.minio.bucket,
        object_key: objectKey,
      }).catch(() => undefined);
      throw error;
    }

    response.status(201).json({
      attachment: {
        id: attachmentId,
        originalName,
        contentType,
        sizeBytes: uploadedFile.size,
      },
    });
  });

  router.get("/files/quota", authenticate, async (request, response) => {
    const user = currentUser(request);
    const result = await query<{ used_bytes: string }>(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS used_bytes
         FROM attachments
        WHERE uploader_id = $1`,
      [user.id],
    );
    const usedBytes = Number(result.rows[0]?.used_bytes ?? 0);
    response.json({
      usedBytes,
      quotaBytes: config.fileUserQuotaBytes,
      remainingBytes: Math.max(0, config.fileUserQuotaBytes - usedBytes),
    });
  });

  router.get("/files/:fileId/content", authenticate, async (request, response) => {
    const user = currentUser(request);
    const fileId = z.string().uuid().parse(request.params.fileId);
    const file = await findAttachment(fileId);
    if (!file || file.state !== "READY") throw new ApiError(404, "文件不存在或尚未就绪");

    // 所有身份参数都显式声明为 UUID。这里既有列比较也有参数互比，若省略转换，
    // PostgreSQL 可能把仅参与参数比较的一侧推断为 text，导致合法图片读取返回 500。
    const access = await query(
      `SELECT 1
         WHERE ($1::uuid IS NULL AND $3::uuid = $2::uuid)
            OR EXISTS (
              SELECT 1
                FROM messages message
                JOIN conversation_members member
                  ON member.conversation_id = message.conversation_id
               WHERE message.id = $1 AND member.user_id = $2
            )
            OR EXISTS (
              SELECT 1
                FROM favorite_attachments favorite_link
                JOIN message_favorites favorite
                  ON favorite.id = favorite_link.favorite_id
               WHERE favorite_link.attachment_id = $4 AND favorite.user_id = $2
            )
            OR EXISTS (
              SELECT 1
                FROM message_attachment_links message_link
                JOIN messages linked_message ON linked_message.id = message_link.message_id
                JOIN conversation_members linked_member
                  ON linked_member.conversation_id = linked_message.conversation_id
                 AND linked_member.user_id = $2
               WHERE message_link.attachment_id = $4
            )
            OR EXISTS (
              SELECT 1
                FROM knowledge_documents knowledge_document
                JOIN knowledge_bases knowledge_base
                  ON knowledge_base.id = knowledge_document.knowledge_base_id
               WHERE knowledge_document.attachment_id = $4
                 AND knowledge_base.owner_id = $2
            )`,
      [file.message_id, user.id, file.uploader_id, file.id],
    );
    if (access.rowCount === 0) throw new ApiError(403, "无权访问该文件");

    const download = request.query.download === "1";
    const disposition =
      download || !file.content_type.startsWith("image/") ? "attachment" : "inline";
    const stream = await retryOperation(() => minio.getObject(file.bucket_name, file.object_key), {
      attempts: config.storageRetryAttempts,
      delayMs: 350,
    });
    response.setHeader("Content-Type", file.content_type);
    response.setHeader("Content-Length", file.size_bytes);
    response.setHeader(
      "Content-Disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    );
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
  });

  router.delete("/files/:fileId", authenticate, async (request, response) => {
    const user = currentUser(request);
    const fileId = z.string().uuid().parse(request.params.fileId);
    const file = await transaction(async (client) => {
      const result = await client.query<AttachmentRow>(
        `SELECT id, uploader_id, message_id, bucket_name, object_key,
                original_name, content_type, size_bytes, state
           FROM attachments
          WHERE id = $1
          FOR UPDATE`,
        [fileId],
      );
      const candidate = result.rows[0];
      if (!candidate) return null;
      if (candidate.uploader_id !== user.id || candidate.message_id) {
        throw new ApiError(409, "已发送的附件不能移除");
      }
      const referenced = await client.query(
        `SELECT 1 FROM favorite_attachments WHERE attachment_id = $1
         UNION ALL
         SELECT 1 FROM message_attachment_links WHERE attachment_id = $1
         UNION ALL
         SELECT 1 FROM knowledge_documents WHERE attachment_id = $1
          LIMIT 1`,
        [fileId],
      );
      if (referenced.rowCount) throw new ApiError(409, "已被消息、收藏或知识库引用的附件不能移除");
      await client.query(
        `UPDATE attachments
            SET state = 'CLEANING', state_updated_at = NOW()
          WHERE id = $1`,
        [fileId],
      );
      return candidate;
    });
    if (!file) {
      response.status(204).end();
      return;
    }
    try {
      await removeAttachmentObject(file);
    } catch (error) {
      await query(
        `UPDATE attachments
            SET state = 'CLEANUP_FAILED', state_updated_at = NOW()
          WHERE id = $1 AND message_id IS NULL`,
        [file.id],
      );
      throw error;
    }
    response.status(204).end();
  });

  return router;
}
