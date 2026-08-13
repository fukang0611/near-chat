import type { PoolClient } from "pg";
import { publicAvatarUrl } from "./avatar-service.js";
import { config } from "./config.js";
import { query } from "./database.js";

export interface AttachmentDto {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ReceiptSummaryDto {
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
}

export interface MessageReplyDto {
  id: string;
  senderId: string;
  senderName: string;
  type: "TEXT" | "IMAGE" | "FILE";
  textContent: string | null;
  attachmentName: string | null;
  recalled: boolean;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarColor: string;
  senderAvatarUrl: string | null;
  clientMessageId: string;
  type: "TEXT" | "IMAGE" | "FILE";
  textContent: string | null;
  createdAt: string;
  recalledAt: string | null;
  recallableUntil: string;
  replyTo: MessageReplyDto | null;
  attachments: AttachmentDto[];
  receipt: ReceiptSummaryDto;
}

export interface MessageCursor {
  createdAt: string;
  id: string;
}

export interface MessagePage {
  messages: MessageDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  sender_avatar_color: string;
  sender_avatar_object_key: string | null;
  sender_avatar_version: number;
  client_message_id: string;
  type: "TEXT" | "IMAGE" | "FILE";
  text_content: string | null;
  created_at: Date;
  recalled_at: Date | null;
  reply_to: {
    id: string;
    senderId: string;
    senderName: string;
    type: "TEXT" | "IMAGE" | "FILE";
    textContent: string | null;
    attachmentName: string | null;
    recalled: boolean;
  } | null;
  attachments: Array<{
    id: string;
    originalName: string;
    contentType: string;
    sizeBytes: string | number;
  }>;
  receipt: {
    recipientCount: string | number;
    deliveredCount: string | number;
    readCount: string | number;
  };
}

const messageSelect = `
  SELECT m.id,
         m.conversation_id,
         m.sender_id,
         u.display_name AS sender_name,
         u.avatar_color AS sender_avatar_color,
         u.avatar_object_key AS sender_avatar_object_key,
         u.avatar_version AS sender_avatar_version,
         m.client_message_id,
         m.type,
         CASE WHEN m.recalled_at IS NULL THEN m.text_content ELSE NULL END AS text_content,
         m.created_at,
         m.recalled_at,
         CASE
           WHEN reply.id IS NULL THEN NULL
           ELSE json_build_object(
             'id', reply.id,
             'senderId', reply.sender_id,
             'senderName', reply_sender.display_name,
             'type', reply.type,
             'textContent', CASE WHEN reply.recalled_at IS NULL THEN reply.text_content ELSE NULL END,
             'attachmentName', CASE WHEN reply.recalled_at IS NULL THEN (
               SELECT reply_attachment.original_name
                 FROM attachments reply_attachment
                WHERE reply_attachment.message_id = reply.id
                ORDER BY reply_attachment.created_at
                LIMIT 1
             ) ELSE NULL END,
             'recalled', reply.recalled_at IS NOT NULL
           )
         END AS reply_to,
         COALESCE(
           (SELECT json_agg(
              json_build_object(
                'id', a.id,
                'originalName', a.original_name,
                'contentType', a.content_type,
                'sizeBytes', a.size_bytes
              ) ORDER BY a.created_at
            )
              FROM attachments a
             WHERE a.message_id = m.id),
           '[]'::json
         ) AS attachments,
         (SELECT json_build_object(
                   'recipientCount', COUNT(*)::int,
                   'deliveredCount', COUNT(delivered_at)::int,
                   'readCount', COUNT(read_at)::int
                 )
            FROM message_receipts mr
           WHERE mr.message_id = m.id) AS receipt
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages reply ON reply.id = m.reply_to_message_id
    LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
`;

// SQL 保持数据库命名，DTO 在唯一出口转换为前端使用的 camelCase。
function toDto(row: MessageRow): MessageDto {
  const createdAt = row.created_at.toISOString();
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderAvatarColor: row.sender_avatar_color,
    senderAvatarUrl: publicAvatarUrl(
      row.sender_id,
      row.sender_avatar_object_key,
      row.sender_avatar_version,
    ),
    clientMessageId: row.client_message_id,
    type: row.type,
    textContent: row.text_content,
    createdAt,
    recalledAt: row.recalled_at?.toISOString() ?? null,
    recallableUntil: new Date(
      row.created_at.getTime() + config.messageRecallWindowSeconds * 1_000,
    ).toISOString(),
    replyTo: row.reply_to,
    attachments: row.attachments.map((attachment) => ({
      ...attachment,
      sizeBytes: Number(attachment.sizeBytes),
    })),
    receipt: {
      recipientCount: Number(row.receipt.recipientCount),
      deliveredCount: Number(row.receipt.deliveredCount),
      readCount: Number(row.receipt.readCount),
    },
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 游标对客户端保持不透明，内部使用时间和 UUID 形成稳定的全序。 */
export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMessageCursor(value: string): MessageCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MessageCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    ) {
      return null;
    }
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

export async function findMessage(
  messageId: string,
  client?: PoolClient,
): Promise<MessageDto | null> {
  const statement = `${messageSelect} WHERE m.id = $1`;
  const result = client
    ? await client.query<MessageRow>(statement, [messageId])
    : await query<MessageRow>(statement, [messageId]);
  return result.rows[0] ? toDto(result.rows[0]) : null;
}

export async function listMessages(
  conversationId: string,
  cursor: MessageCursor | null,
  limit: number,
  legacyBefore: Date | null = null,
): Promise<MessagePage> {
  const result = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND (
          $2::timestamptz IS NULL
          OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid)
        )
        AND ($4::timestamptz IS NULL OR m.created_at < $4::timestamptz)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $5`,
    [
      conversationId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      legacyBefore?.toISOString() ?? null,
      limit + 1,
    ],
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const oldest = pageRows.at(-1);
  return {
    messages: pageRows.reverse().map(toDto),
    nextCursor:
      hasMore && oldest
        ? encodeMessageCursor({ createdAt: oldest.created_at.toISOString(), id: oldest.id })
        : null,
    hasMore,
  };
}

/** 返回搜索命中消息前后的上下文，使前端可以准确跳转而不是只打开会话末尾。 */
export async function listMessagesAround(
  conversationId: string,
  messageId: string,
  limit: number,
): Promise<MessagePage> {
  const target = await query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM messages WHERE id = $1 AND conversation_id = $2`,
    [messageId, conversationId],
  );
  const targetMessage = target.rows[0];
  if (!targetMessage) return { messages: [], nextCursor: null, hasMore: false };

  const beforeLimit = Math.ceil(limit / 2);
  const before = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND (m.created_at, m.id) <= ($2::timestamptz, $3::uuid)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $4`,
    [conversationId, targetMessage.created_at.toISOString(), targetMessage.id, beforeLimit + 1],
  );
  const hasMore = before.rows.length > beforeLimit;
  const beforeRows = before.rows.slice(0, beforeLimit);

  const afterLimit = Math.max(0, limit - beforeRows.length);
  const after = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND (m.created_at, m.id) > ($2::timestamptz, $3::uuid)
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $4`,
    [conversationId, targetMessage.created_at.toISOString(), targetMessage.id, afterLimit],
  );
  const oldest = beforeRows.at(-1);
  return {
    messages: [...beforeRows.reverse(), ...after.rows].map(toDto),
    nextCursor:
      hasMore && oldest
        ? encodeMessageCursor({ createdAt: oldest.created_at.toISOString(), id: oldest.id })
        : null,
    hasMore,
  };
}

function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, "\\$&");
}

/**
 * 在当前用户有权访问的全部会话中搜索文本和附件名。
 * 使用 ILIKE 而非 PostgreSQL 分词，保证中文连续文本也能直接命中。
 */
export async function searchMessages(
  userId: string,
  keyword: string,
  conversationId: string | null,
  limit: number,
): Promise<MessageDto[]> {
  const pattern = `%${escapeLikePattern(keyword)}%`;
  const result = await query<MessageRow>(
    `${messageSelect}
      WHERE EXISTS (
              SELECT 1
                FROM conversation_members mine
               WHERE mine.conversation_id = m.conversation_id
                 AND mine.user_id = $1
            )
        AND m.recalled_at IS NULL
        AND ($2::uuid IS NULL OR m.conversation_id = $2)
        AND (
          m.text_content ILIKE $3 ESCAPE '\\'
          OR EXISTS (
            SELECT 1
              FROM attachments matched_attachment
             WHERE matched_attachment.message_id = m.id
               AND matched_attachment.original_name ILIKE $3 ESCAPE '\\'
          )
        )
      ORDER BY m.created_at DESC
      LIMIT $4`,
    [userId, conversationId, pattern, limit],
  );
  return result.rows.map(toDto);
}
