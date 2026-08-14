import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PoolClient, QueryResultRow } from "pg";
import { removeAttachmentObject } from "../attachment-cleanup.js";
import { stageDetachedAttachmentsForCleanup } from "../attachment-references.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import {
  extractKnowledgeDocument,
  supportsKnowledgeDocument,
} from "../knowledge/document-extractor.js";
import { minio } from "../minio.js";
import { retryOperation } from "../retry.js";

export type AiAssistantFileOrigin = "CHAT" | "UPLOAD" | "GENERATED";
export type AiAssistantGeneratedFileFormat = "MARKDOWN" | "TEXT";

export const ASSISTANT_FILE_LIMIT = 30;
export const ASSISTANT_MESSAGE_FILE_LIMIT = 5;
const ASSISTANT_FILE_CONTEXT_LIMIT = 80_000;

interface AssistantFileRow {
  id: string;
  assistant_id: string;
  owner_id: string;
  attachment_id: string;
  origin: AiAssistantFileOrigin;
  source_message_id: string | null;
  original_name: string;
  content_type: string;
  size_bytes: string;
  bucket_name: string;
  object_key: string;
  state: "PENDING" | "READY" | "CLEANING" | "CLEANUP_FAILED";
  created_at: Date;
}

export interface AssistantFileContext {
  assistantFileId: string;
  name: string;
  content: string;
  truncated: boolean;
}

interface ExtractedAssistantFile {
  assistantFileId: string;
  name: string;
  text: string;
}

export interface AssistantMessageFileBundle {
  referencedFiles: ReturnType<typeof publicAssistantFile>[];
  generatedFiles: ReturnType<typeof publicAssistantFile>[];
}

const ASSISTANT_FILE_COLUMNS = `
  assistant_file.id, assistant_file.assistant_id, assistant_file.owner_id,
  assistant_file.attachment_id, assistant_file.origin, assistant_file.source_message_id,
  attachment.original_name, attachment.content_type, attachment.size_bytes::text,
  attachment.bucket_name, attachment.object_key, attachment.state,
  assistant_file.created_at`;

function publicAssistantFile(row: AssistantFileRow) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    origin: row.origin,
    sourceMessageId: row.source_message_id,
    attachment: {
      id: row.attachment_id,
      originalName: row.original_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
    },
    processable: supportsKnowledgeDocument(row.original_name, row.content_type),
    createdAt: row.created_at.toISOString(),
  };
}

async function assertAssistantOwner(
  client: PoolClient,
  userId: string,
  assistantId: string,
  lock = false,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM ai_assistants
      WHERE id = $1 AND owner_id = $2${lock ? " FOR UPDATE" : ""}`,
    [assistantId, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "智能助理不存在");
}

async function findAssistantFile(
  userId: string,
  assistantId: string,
  fileId: string,
  client?: PoolClient,
): Promise<AssistantFileRow | null> {
  const statement = `SELECT ${ASSISTANT_FILE_COLUMNS}
     FROM ai_assistant_files assistant_file
     JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
    WHERE assistant_file.id = $1
      AND assistant_file.assistant_id = $2
      AND assistant_file.owner_id = $3`;
  const result = client
    ? await client.query<AssistantFileRow>(statement, [fileId, assistantId, userId])
    : await query<AssistantFileRow>(statement, [fileId, assistantId, userId]);
  return result.rows[0] ?? null;
}

export async function listAiAssistantFiles(userId: string, assistantId: string) {
  const result = await query<AssistantFileRow>(
    `SELECT ${ASSISTANT_FILE_COLUMNS}
       FROM ai_assistant_files assistant_file
       JOIN ai_assistants assistant ON assistant.id = assistant_file.assistant_id
       JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
      WHERE assistant_file.assistant_id = $1
        AND assistant.owner_id = $2
        AND attachment.state = 'READY'
      ORDER BY assistant_file.created_at DESC, assistant_file.id DESC`,
    [assistantId, userId],
  );
  if (result.rows.length === 0) {
    const exists = await query(`SELECT 1 FROM ai_assistants WHERE id = $1 AND owner_id = $2`, [
      assistantId,
      userId,
    ]);
    if (!exists.rowCount) throw new ApiError(404, "智能助理不存在");
  }
  return result.rows.map(publicAssistantFile);
}

/**
 * 把已有附件加入助理工作区。聊天来源必须仍属于用户可见的未撤回消息；独立上传
 * 则必须由当前用户创建且尚未发送，防止仅凭附件 UUID 扩大访问范围。
 */
export async function addAiAssistantFile(
  userId: string,
  assistantId: string,
  attachmentId: string,
  origin: Exclude<AiAssistantFileOrigin, "GENERATED">,
) {
  return transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId, true);
    const existing = await client.query<AssistantFileRow>(
      `SELECT ${ASSISTANT_FILE_COLUMNS}
         FROM ai_assistant_files assistant_file
         JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
        WHERE assistant_file.assistant_id = $1 AND assistant_file.attachment_id = $2`,
      [assistantId, attachmentId],
    );
    if (existing.rows[0]) return publicAssistantFile(existing.rows[0]);

    const count = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ai_assistant_files WHERE assistant_id = $1`,
      [assistantId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_FILE_LIMIT) {
      throw new ApiError(400, `每个助理最多保存 ${ASSISTANT_FILE_LIMIT} 个文件`);
    }

    const attachment = await client.query<{
      uploader_id: string;
      message_id: string | null;
      state: string;
      chat_access: boolean;
    }>(
      `SELECT attachment.uploader_id, attachment.message_id, attachment.state,
              EXISTS (
                SELECT 1
                  FROM (
                    SELECT attachment.message_id AS message_id
                     WHERE attachment.message_id IS NOT NULL
                    UNION
                    SELECT message_link.message_id
                      FROM message_attachment_links message_link
                     WHERE message_link.attachment_id = attachment.id
                  ) source
                  JOIN messages message ON message.id = source.message_id
                  JOIN conversation_members member
                    ON member.conversation_id = message.conversation_id
                   AND member.user_id = $2
                 WHERE message.recalled_at IS NULL
              ) AS chat_access
         FROM attachments attachment
        WHERE attachment.id = $1
        FOR SHARE`,
      [attachmentId, userId],
    );
    const candidate = attachment.rows[0];
    if (!candidate || candidate.state !== "READY") {
      throw new ApiError(404, "文件不存在或尚未就绪");
    }
    if (origin === "CHAT" && !candidate.chat_access) {
      throw new ApiError(403, "该聊天文件已不可访问");
    }
    if (
      origin === "UPLOAD" &&
      (candidate.uploader_id !== userId || candidate.message_id !== null)
    ) {
      throw new ApiError(403, "只能添加自己尚未发送的上传文件");
    }

    const fileId = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_files
         (id, assistant_id, owner_id, attachment_id, origin)
       VALUES ($1, $2, $3, $4, $5)`,
      [fileId, assistantId, userId, attachmentId, origin],
    );
    const file = await findAssistantFile(userId, assistantId, fileId, client);
    if (!file) throw new ApiError(500, "助理文件创建失败");
    return publicAssistantFile(file);
  });
}

export async function removeAiAssistantFile(
  userId: string,
  assistantId: string,
  fileId: string,
): Promise<void> {
  await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId, true);
    const result = await client.query<{ attachment_id: string }>(
      `DELETE FROM ai_assistant_files
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3
        RETURNING attachment_id`,
      [fileId, assistantId, userId],
    );
    const attachmentId = result.rows[0]?.attachment_id;
    if (attachmentId) await stageDetachedAttachmentsForCleanup(client, [attachmentId]);
  });
}

async function downloadAssistantFile(row: AssistantFileRow): Promise<Buffer> {
  const expectedBytes = Number(row.size_bytes);
  if (
    row.state !== "READY" ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > config.fileMaxBytes
  ) {
    throw new ApiError(422, `文件“${row.original_name}”尚未就绪或大小超出限制`);
  }
  const stream = await retryOperation(() => minio.getObject(row.bucket_name, row.object_key), {
    attempts: config.storageRetryAttempts,
    delayMs: 350,
  });
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of stream) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    bytes += buffer.length;
    if (bytes > config.fileMaxBytes) {
      stream.destroy();
      throw new ApiError(422, `文件“${row.original_name}”读取大小超出限制`);
    }
    parts.push(buffer);
  }
  return Buffer.concat(parts, bytes);
}

/** 只加载本轮显式选择的文档，并在服务端提取文字；原始二进制不会发送给模型。 */
export async function loadAssistantFileContexts(
  userId: string,
  assistantId: string,
  fileIds: string[],
): Promise<AssistantFileContext[]> {
  if (fileIds.length === 0) return [];
  const uniqueIds = [...new Set(fileIds)];
  if (uniqueIds.length > ASSISTANT_MESSAGE_FILE_LIMIT) {
    throw new ApiError(400, `每次最多引用 ${ASSISTANT_MESSAGE_FILE_LIMIT} 个文件`);
  }
  const result = await query<AssistantFileRow>(
    `SELECT ${ASSISTANT_FILE_COLUMNS}
       FROM ai_assistant_files assistant_file
       JOIN ai_assistants assistant ON assistant.id = assistant_file.assistant_id
       JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
      WHERE assistant_file.id = ANY($1::uuid[])
        AND assistant_file.assistant_id = $2
        AND assistant.owner_id = $3`,
    [uniqueIds, assistantId, userId],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new ApiError(400, "所选文件不存在或已从助理工作区移除");
  }
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const extractedFiles: ExtractedAssistantFile[] = [];
  for (const fileId of uniqueIds) {
    const row = byId.get(fileId)!;
    if (!supportsKnowledgeDocument(row.original_name, row.content_type)) {
      throw new ApiError(422, `文件“${row.original_name}”暂不支持文字提取`);
    }
    let extracted: Awaited<ReturnType<typeof extractKnowledgeDocument>>;
    try {
      extracted = await extractKnowledgeDocument(
        await downloadAssistantFile(row),
        row.original_name,
        row.content_type,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, `无法提取文件“${row.original_name}”中的文字`);
    }
    extractedFiles.push({
      assistantFileId: row.id,
      name: row.original_name,
      text: extracted.text,
    });
  }

  return allocateAssistantFileContexts(extractedFiles);
}

/** 公平分配总上下文预算，让每个显式选择的文件都至少获得一段可见内容。 */
export function allocateAssistantFileContexts(
  files: ExtractedAssistantFile[],
  limit = ASSISTANT_FILE_CONTEXT_LIMIT,
): AssistantFileContext[] {
  // 按剩余文件数公平分配上下文预算：短文件未用完的额度会自然留给后续文件，
  // 同时避免第一个大文件吃满上限，让用户明确勾选的后续文件完全缺席。
  let remaining = Math.max(0, limit);
  const contexts: AssistantFileContext[] = [];
  for (const [index, extracted] of files.entries()) {
    const allowance = Math.floor(remaining / (files.length - index));
    const content = extracted.text.slice(0, allowance);
    contexts.push({
      assistantFileId: extracted.assistantFileId,
      name: extracted.name,
      content,
      truncated: content.length < extracted.text.length,
    });
    remaining -= content.length;
  }
  return contexts;
}

export async function linkAssistantFilesToMessage(
  client: PoolClient,
  assistantId: string,
  messageId: string,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const uniqueIds = [...new Set(fileIds)];
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ai_assistant_files
      WHERE assistant_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE`,
    [assistantId, uniqueIds],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new ApiError(409, "生成回复期间引用文件已被移除，请重新发送");
  }
  await client.query(
    `INSERT INTO ai_assistant_message_files (message_id, assistant_file_id)
     SELECT $1, file_id FROM unnest($2::uuid[]) AS file_id`,
    [messageId, uniqueIds],
  );
}

export async function loadAssistantMessageFileBundles(
  assistantId: string,
  messageIds: string[],
  client?: PoolClient,
): Promise<Map<string, AssistantMessageFileBundle>> {
  const bundles = new Map<string, AssistantMessageFileBundle>();
  for (const messageId of messageIds) {
    bundles.set(messageId, { referencedFiles: [], generatedFiles: [] });
  }
  if (messageIds.length === 0) return bundles;
  const run = <T extends QueryResultRow>(statement: string, values: unknown[]) =>
    client ? client.query<T>(statement, values) : query<T>(statement, values);

  const referenced = await run<AssistantFileRow & { message_id: string }>(
    `SELECT message_link.message_id, ${ASSISTANT_FILE_COLUMNS}
       FROM ai_assistant_message_files message_link
       JOIN ai_assistant_files assistant_file ON assistant_file.id = message_link.assistant_file_id
       JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
      WHERE message_link.message_id = ANY($1::uuid[])
        AND assistant_file.assistant_id = $2
        AND attachment.state = 'READY'
      ORDER BY assistant_file.created_at, assistant_file.id`,
    [messageIds, assistantId],
  );
  for (const row of referenced.rows) {
    bundles.get(row.message_id)?.referencedFiles.push(publicAssistantFile(row));
  }

  const generated = await run<AssistantFileRow>(
    `SELECT ${ASSISTANT_FILE_COLUMNS}
       FROM ai_assistant_files assistant_file
       JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
      WHERE assistant_file.assistant_id = $1
        AND assistant_file.source_message_id = ANY($2::uuid[])
        AND attachment.state = 'READY'
      ORDER BY assistant_file.created_at, assistant_file.id`,
    [assistantId, messageIds],
  );
  for (const row of generated.rows) {
    if (row.source_message_id) {
      bundles.get(row.source_message_id)?.generatedFiles.push(publicAssistantFile(row));
    }
  }
  return bundles;
}

export function normalizeGeneratedFileName(
  requestedName: string | undefined,
  format: AiAssistantGeneratedFileFormat,
): string {
  const suffix = format === "MARKDOWN" ? ".md" : ".txt";
  const decoded = (requestedName ?? "助理回复").replaceAll("\\", "/");
  const base = path
    .basename(decoded)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/\.(md|txt)$/i, "")
    .trim()
    .slice(0, 180);
  return `${base || "助理回复"}${suffix}`;
}

/** 用户明确点击“保存为文件”后才会写入 MinIO；模型本身没有文件写入权限。 */
export async function saveAssistantMessageAsFile(input: {
  userId: string;
  assistantId: string;
  messageId: string;
  format: AiAssistantGeneratedFileFormat;
  name?: string;
}) {
  const fileName = normalizeGeneratedFileName(input.name, input.format);
  const contentType =
    input.format === "MARKDOWN" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  const attachmentId = randomUUID();
  const now = new Date();
  const objectKey = [
    input.userId,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    attachmentId,
  ].join("/");
  let content = "";

  await transaction(async (client) => {
    await assertAssistantOwner(client, input.userId, input.assistantId, true);
    const message = await client.query<{ content: string }>(
      `SELECT content
         FROM ai_assistant_messages
        WHERE id = $1 AND assistant_id = $2 AND role = 'ASSISTANT'
        FOR SHARE`,
      [input.messageId, input.assistantId],
    );
    if (!message.rows[0]) throw new ApiError(404, "助理回复不存在");
    content = message.rows[0].content;
    const fileCount = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ai_assistant_files WHERE assistant_id = $1`,
      [input.assistantId],
    );
    if (Number(fileCount.rows[0]?.total ?? 0) >= ASSISTANT_FILE_LIMIT) {
      throw new ApiError(400, `每个助理最多保存 ${ASSISTANT_FILE_LIMIT} 个文件`);
    }
    const body = Buffer.from(content, "utf8");
    if (body.length > config.fileMaxBytes) throw new ApiError(413, "助理回复超过文件大小限制");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.userId]);
    const usage = await client.query<{ used_bytes: string }>(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS used_bytes
         FROM attachments
        WHERE uploader_id = $1`,
      [input.userId],
    );
    if (Number(usage.rows[0]?.used_bytes ?? 0) + body.length > config.fileUserQuotaBytes) {
      throw new ApiError(413, "个人文件空间不足，无法保存助理回复");
    }
    await client.query(
      `INSERT INTO attachments
         (id, uploader_id, bucket_name, object_key, original_name,
          content_type, size_bytes, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
      [
        attachmentId,
        input.userId,
        config.minio.bucket,
        objectKey,
        fileName,
        contentType,
        body.length,
      ],
    );
  });

  const body = Buffer.from(content, "utf8");
  try {
    await retryOperation(
      () =>
        minio.putObject(config.minio.bucket, objectKey, body, body.length, {
          "Content-Type": contentType,
        }),
      { attempts: config.storageRetryAttempts, delayMs: 500 },
    );
    return await transaction(async (client) => {
      await assertAssistantOwner(client, input.userId, input.assistantId, true);
      const message = await client.query(
        `SELECT 1 FROM ai_assistant_messages
          WHERE id = $1 AND assistant_id = $2 AND role = 'ASSISTANT'
          FOR SHARE`,
        [input.messageId, input.assistantId],
      );
      if (!message.rowCount) throw new ApiError(409, "助理回复已被清除，无法保存文件");
      const fileCount = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ai_assistant_files WHERE assistant_id = $1`,
        [input.assistantId],
      );
      if (Number(fileCount.rows[0]?.total ?? 0) >= ASSISTANT_FILE_LIMIT) {
        throw new ApiError(409, `文件工作区已达到 ${ASSISTANT_FILE_LIMIT} 个上限`);
      }
      const fileId = randomUUID();
      await client.query(
        `UPDATE attachments SET state = 'READY', state_updated_at = NOW() WHERE id = $1`,
        [attachmentId],
      );
      await client.query(
        `INSERT INTO ai_assistant_files
           (id, assistant_id, owner_id, attachment_id, origin, source_message_id)
         VALUES ($1, $2, $3, $4, 'GENERATED', $5)`,
        [fileId, input.assistantId, input.userId, attachmentId, input.messageId],
      );
      const file = await findAssistantFile(input.userId, input.assistantId, fileId, client);
      if (!file) throw new ApiError(500, "助理文件保存失败");
      return publicAssistantFile(file);
    });
  } catch (error) {
    await query(
      `UPDATE attachments SET state = 'CLEANUP_FAILED', state_updated_at = NOW() WHERE id = $1`,
      [attachmentId],
    ).catch(() => undefined);
    await removeAttachmentObject({
      id: attachmentId,
      bucket_name: config.minio.bucket,
      object_key: objectKey,
    }).catch(() => undefined);
    throw error;
  }
}
