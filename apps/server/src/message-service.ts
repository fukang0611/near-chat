import type { PoolClient } from "pg";
import { query } from "./database.js";

export interface AttachmentDto {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
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
         ) AS attachments
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
