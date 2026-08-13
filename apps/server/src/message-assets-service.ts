import { query } from "./database.js";
import type { AttachmentDto } from "./message-service.js";

export type ChatFileCategory = "ALL" | "IMAGE" | "AUDIO" | "FILE";

export interface ChatFileDto {
  attachment: AttachmentDto;
  category: Exclude<ChatFileCategory, "ALL">;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  messageText: string | null;
  createdAt: string;
}

export interface ChatFilePage {
  files: ChatFileDto[];
  total: number;
  totalBytes: number;
  offset: number;
  hasMore: boolean;
}

interface ChatFileRow {
  id: string;
  original_name: string;
  content_type: string;
  size_bytes: string;
  category: Exclude<ChatFileCategory, "ALL">;
  message_id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  message_text: string | null;
  created_at: Date;
  total_count: number;
  total_bytes: string;
}

function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, "\\$&");
}

/**
 * 返回当前用户仍有权访问的会话附件。权限在数据库连接链路中完成校验，
 * 前端传入的会话 ID 只作为筛选条件，不能扩大可见范围。
 */
export async function listChatFiles(
  userId: string,
  input: {
    keyword?: string;
    category: ChatFileCategory;
    conversationId?: string;
    limit: number;
    offset: number;
  },
): Promise<ChatFilePage> {
  const pattern = input.keyword ? `%${escapeLikePattern(input.keyword)}%` : null;
  const result = await query<ChatFileRow>(
    `WITH accessible_files AS (
       SELECT attachment.id,
              attachment.original_name,
              attachment.content_type,
              attachment.size_bytes,
              CASE
                WHEN attachment.content_type LIKE 'image/%' THEN 'IMAGE'
                WHEN attachment.content_type LIKE 'audio/%' THEN 'AUDIO'
                ELSE 'FILE'
              END AS category,
              message.id AS message_id,
              message.conversation_id,
              message.sender_id,
              sender.display_name AS sender_name,
              message.text_content AS message_text,
              message.created_at
         FROM attachments attachment
         JOIN messages message ON message.id = attachment.message_id
         JOIN users sender ON sender.id = message.sender_id
         JOIN conversation_members mine
           ON mine.conversation_id = message.conversation_id AND mine.user_id = $1
        WHERE attachment.state = 'READY'
          AND message.recalled_at IS NULL
          AND ($2::uuid IS NULL OR message.conversation_id = $2)
          AND ($3::text IS NULL OR attachment.original_name ILIKE $3 ESCAPE '\\')
     )
     SELECT accessible_files.*,
            COUNT(*) OVER()::int AS total_count,
            COALESCE(SUM(size_bytes) OVER(), 0)::text AS total_bytes
       FROM accessible_files
      WHERE $4 = 'ALL' OR category = $4
      ORDER BY created_at DESC, id DESC
      LIMIT $5 OFFSET $6`,
    [userId, input.conversationId ?? null, pattern, input.category, input.limit, input.offset],
  );

  const first = result.rows[0];
  const total = Number(first?.total_count ?? 0);
  return {
    files: result.rows.map((row) => ({
      attachment: {
        id: row.id,
        originalName: row.original_name,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
      },
      category: row.category,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      messageText: row.message_text,
      createdAt: row.created_at.toISOString(),
    })),
    total,
    totalBytes: Number(first?.total_bytes ?? 0),
    offset: input.offset,
    hasMore: input.offset + result.rows.length < total,
  };
}
