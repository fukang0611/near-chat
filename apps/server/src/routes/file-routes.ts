import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { config } from "../config.js";
import { query } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { minio } from "../minio.js";

interface AttachmentRow {
  id: string;
  uploader_id: string;
  message_id: string | null;
  bucket_name: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: string;
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
            original_name, content_type, size_bytes
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

    const attachmentId = randomUUID();
    const now = new Date();
    const objectKey = [
      user.id,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      attachmentId,
    ].join("/");
    const originalName = safeFileName(request.file.originalname);
    const contentType = request.file.mimetype || "application/octet-stream";

    await minio.putObject(config.minio.bucket, objectKey, request.file.buffer, request.file.size, {
      "Content-Type": contentType,
    });

    try {
      await query(
        `INSERT INTO attachments
             (id, uploader_id, bucket_name, object_key, original_name,
              content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          attachmentId,
          user.id,
          config.minio.bucket,
          objectKey,
          originalName,
          contentType,
          request.file.size,
        ],
      );
    } catch (error) {
      // 元数据写入失败时回收刚上传的对象，避免产生不可见的孤儿文件。
      await minio.removeObject(config.minio.bucket, objectKey).catch(() => undefined);
      throw error;
    }

    response.status(201).json({
      attachment: {
        id: attachmentId,
        originalName,
        contentType,
        sizeBytes: request.file.size,
      },
    });
  });

  router.get("/files/:fileId/content", authenticate, async (request, response) => {
    const user = currentUser(request);
    const fileId = z.string().uuid().parse(request.params.fileId);
    const file = await findAttachment(fileId);
    if (!file) throw new ApiError(404, "文件不存在");

    if (file.message_id) {
      const access = await query(
        `SELECT 1
           FROM messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
          WHERE m.id = $1 AND cm.user_id = $2`,
        [file.message_id, user.id],
      );
      if (access.rowCount === 0) throw new ApiError(403, "无权访问该文件");
    } else if (file.uploader_id !== user.id) {
      throw new ApiError(403, "无权访问该文件");
    }

    const download = request.query.download === "1";
    const disposition =
      download || !file.content_type.startsWith("image/") ? "attachment" : "inline";
    response.setHeader("Content-Type", file.content_type);
    response.setHeader("Content-Length", file.size_bytes);
    response.setHeader(
      "Content-Disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    );
    const stream = await minio.getObject(file.bucket_name, file.object_key);
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
  });

  router.delete("/files/:fileId", authenticate, async (request, response) => {
    const user = currentUser(request);
    const fileId = z.string().uuid().parse(request.params.fileId);
    const file = await findAttachment(fileId);
    if (!file) {
      response.status(204).end();
      return;
    }
    if (file.uploader_id !== user.id || file.message_id) {
      throw new ApiError(409, "已发送的附件不能移除");
    }

    await minio.removeObject(file.bucket_name, file.object_key);
    await query("DELETE FROM attachments WHERE id = $1", [fileId]);
    response.status(204).end();
  });

  return router;
}
