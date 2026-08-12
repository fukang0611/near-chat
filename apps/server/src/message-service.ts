import type { PoolClient } from "pg";
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

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarColor: string;
  clientMessageId: string;
  type: "TEXT" | "IMAGE" | "FILE";
  textContent: string | null;
  createdAt: string;
  attachments: AttachmentDto[];
  receipt: ReceiptSummaryDto;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  sender_avatar_color: string;
  client_message_id: string;
  type: "TEXT" | "IMAGE" | "FILE";
  text_content: string | null;
  created_at: Date;
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
         m.client_message_id,
         m.type,
         m.text_content,
         m.created_at,
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
`;

// SQL 保持数据库命名，DTO 在唯一出口转换为前端使用的 camelCase。
function toDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderAvatarColor: row.sender_avatar_color,
    clientMessageId: row.client_message_id,
    type: row.type,
    textContent: row.text_content,
    createdAt: row.created_at.toISOString(),
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
  before: Date | null,
  limit: number,
): Promise<MessageDto[]> {
  const result = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, before?.toISOString() ?? null, limit],
  );
  return result.rows.reverse().map(toDto);
}

/** 返回搜索命中消息前后的上下文，使前端可以准确跳转而不是只打开会话末尾。 */
export async function listMessagesAround(
  conversationId: string,
  messageId: string,
  limit: number,
): Promise<MessageDto[]> {
  const beforeLimit = Math.ceil(limit / 2);
  const before = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND m.created_at <= (
          SELECT created_at FROM messages WHERE id = $2 AND conversation_id = $1
        )
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, messageId, beforeLimit],
  );
  if (before.rows.length === 0) return [];

  const afterLimit = Math.max(0, limit - before.rows.length);
  const after = await query<MessageRow>(
    `${messageSelect}
      WHERE m.conversation_id = $1
        AND m.created_at > (
          SELECT created_at FROM messages WHERE id = $2 AND conversation_id = $1
        )
      ORDER BY m.created_at ASC
      LIMIT $3`,
    [conversationId, messageId, afterLimit],
  );
  return [...before.rows.reverse(), ...after.rows].map(toDto);
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
