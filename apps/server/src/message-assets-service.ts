import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { stageDetachedAttachmentsForCleanup } from "./attachment-references.js";
import { publicAvatarUrl } from "./avatar-service.js";
import { query, transaction } from "./database.js";
import { ApiError } from "./http.js";
import type { MessageKind } from "./message-kind.js";
import type { AttachmentDto, ForwardedMessageSourceDto } from "./message-service.js";

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

export interface MessageFavoriteDto {
  id: string;
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  sourceConversationTitle: string;
  sourceSenderId: string | null;
  sourceSenderName: string;
  sourceSenderAvatarColor: string;
  sourceSenderAvatarUrl: string | null;
  type: MessageKind;
  textContent: string | null;
  forwardedFrom: ForwardedMessageSourceDto | null;
  messageCreatedAt: string;
  createdAt: string;
  attachments: AttachmentDto[];
  sourceAvailable: boolean;
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

interface FavoriteRow {
  id: string;
  source_message_id: string | null;
  source_conversation_id: string | null;
  source_conversation_title: string;
  source_sender_id: string | null;
  source_sender_name: string;
  source_sender_avatar_color: string;
  source_sender_avatar_object_key: string | null;
  source_sender_avatar_version: number;
  source_type: MessageKind;
  text_content: string | null;
  forwarded_from: ForwardedMessageSourceDto | null;
  message_created_at: Date;
  created_at: Date;
  attachments: Array<{
    id: string;
    originalName: string;
    contentType: string;
    sizeBytes: string | number;
  }>;
  source_available: boolean;
}

interface FavoriteSourceRow {
  id: string;
  conversation_id: string;
  conversation_title: string;
  sender_id: string;
  sender_name: string;
  sender_avatar_color: string;
  type: MessageKind;
  text_content: string | null;
  forwarded_from: ForwardedMessageSourceDto | null;
  created_at: Date;
  recalled_at: Date | null;
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
              COALESCE(message.actor_name, sender.display_name) AS sender_name,
              message.text_content AS message_text,
              message.created_at
         FROM (
           SELECT owned_attachment.message_id, owned_attachment.id AS attachment_id
             FROM attachments owned_attachment
            WHERE owned_attachment.message_id IS NOT NULL
           UNION
           SELECT message_link.message_id, message_link.attachment_id
             FROM message_attachment_links message_link
         ) message_asset
         JOIN attachments attachment ON attachment.id = message_asset.attachment_id
         JOIN messages message ON message.id = message_asset.message_id
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

const favoriteSelect = `
  SELECT favorite.id,
         favorite.source_message_id,
         favorite.source_conversation_id,
         favorite.source_conversation_title,
         favorite.source_sender_id,
         favorite.source_sender_name,
         favorite.source_sender_avatar_color,
         source_sender.avatar_object_key AS source_sender_avatar_object_key,
         COALESCE(source_sender.avatar_version, 0)::int AS source_sender_avatar_version,
         favorite.source_type,
         favorite.text_content,
         favorite.forwarded_from,
         favorite.message_created_at,
         favorite.created_at,
         COALESCE(
           (SELECT json_agg(
              json_build_object(
                'id', attachment.id,
                'originalName', attachment.original_name,
                'contentType', attachment.content_type,
                'sizeBytes', attachment.size_bytes
              ) ORDER BY attachment.created_at
            )
              FROM favorite_attachments favorite_link
              JOIN attachments attachment ON attachment.id = favorite_link.attachment_id
             WHERE favorite_link.favorite_id = favorite.id
               AND attachment.state = 'READY'),
           '[]'::json
         ) AS attachments,
         EXISTS (
           SELECT 1
             FROM messages source_message
             JOIN conversation_members mine
               ON mine.conversation_id = source_message.conversation_id
              AND mine.user_id = favorite.user_id
            WHERE source_message.id = favorite.source_message_id
              AND source_message.recalled_at IS NULL
         ) AS source_available
    FROM message_favorites favorite
    LEFT JOIN users source_sender ON source_sender.id = favorite.source_sender_id
`;

function toFavoriteDto(row: FavoriteRow): MessageFavoriteDto {
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    sourceConversationId: row.source_conversation_id,
    sourceConversationTitle: row.source_conversation_title,
    sourceSenderId: row.source_sender_id,
    sourceSenderName: row.source_sender_name,
    sourceSenderAvatarColor: row.source_sender_avatar_color,
    sourceSenderAvatarUrl: row.source_sender_id
      ? publicAvatarUrl(
          row.source_sender_id,
          row.source_sender_avatar_object_key,
          row.source_sender_avatar_version,
        )
      : null,
    type: row.source_type,
    textContent: row.text_content,
    forwardedFrom: row.forwarded_from,
    messageCreatedAt: row.message_created_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    attachments: row.attachments.map((attachment) => ({
      ...attachment,
      sizeBytes: Number(attachment.sizeBytes),
    })),
    sourceAvailable: row.source_available,
  };
}

async function findFavorite(
  userId: string,
  favoriteId: string,
  client?: PoolClient,
): Promise<MessageFavoriteDto | null> {
  const statement = `${favoriteSelect}
    WHERE favorite.user_id = $1 AND favorite.id = $2`;
  const result = client
    ? await client.query<FavoriteRow>(statement, [userId, favoriteId])
    : await query<FavoriteRow>(statement, [userId, favoriteId]);
  return result.rows[0] ? toFavoriteDto(result.rows[0]) : null;
}

/** 收藏列表使用快照内容，即使原消息撤回或会话解散也能继续展示。 */
export async function listMessageFavorites(userId: string): Promise<MessageFavoriteDto[]> {
  const result = await query<FavoriteRow>(
    `${favoriteSelect}
      WHERE favorite.user_id = $1
      ORDER BY favorite.created_at DESC, favorite.id DESC
      LIMIT 500`,
    [userId],
  );
  return result.rows.map(toFavoriteDto);
}

/**
 * 收藏时锁定源消息并保存稳定快照；附件只增加引用，不复制 MinIO 对象。
 * 同一用户重复收藏同一消息会返回原收藏，便于客户端安全重试。
 */
export async function createMessageFavorite(
  userId: string,
  messageId: string,
): Promise<{ favorite: MessageFavoriteDto; created: boolean }> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      userId,
      messageId,
    ]);
    const existing = await client.query<{ id: string }>(
      `SELECT id
         FROM message_favorites
        WHERE user_id = $1 AND source_message_id = $2`,
      [userId, messageId],
    );
    if (existing.rows[0]) {
      const favorite = await findFavorite(userId, existing.rows[0].id, client);
      if (!favorite) throw new ApiError(500, "收藏记录读取失败");
      return { favorite, created: false };
    }

    const sourceResult = await client.query<FavoriteSourceRow>(
      `SELECT message.id,
              message.conversation_id,
              CASE
                WHEN conversation.type = 'GROUP' THEN COALESCE(conversation.name, '未命名群聊')
                ELSE COALESCE(
                  (SELECT peer.display_name
                     FROM conversation_members peer_member
                     JOIN users peer ON peer.id = peer_member.user_id
                    WHERE peer_member.conversation_id = conversation.id
                      AND peer_member.user_id <> $2
                    ORDER BY peer_member.joined_at
                    LIMIT 1),
                  '私聊'
                )
              END AS conversation_title,
              message.sender_id,
              COALESCE(message.actor_name, sender.display_name) AS sender_name,
              COALESCE(message.actor_avatar_color, sender.avatar_color) AS sender_avatar_color,
              message.type,
              message.text_content,
              message.forwarded_from,
              message.created_at,
              message.recalled_at
         FROM messages message
         JOIN conversations conversation ON conversation.id = message.conversation_id
         JOIN conversation_members mine
           ON mine.conversation_id = message.conversation_id AND mine.user_id = $2
         JOIN users sender ON sender.id = message.sender_id
        WHERE message.id = $1
        FOR SHARE OF message`,
      [messageId, userId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new ApiError(404, "消息不存在或无权访问");
    if (source.recalled_at) throw new ApiError(409, "已撤回的消息不能收藏");

    const favoriteId = randomUUID();
    await client.query(
      `INSERT INTO message_favorites
         (id, user_id, source_message_id, source_conversation_id,
          source_conversation_title, source_sender_id, source_sender_name,
          source_sender_avatar_color, source_type, text_content, forwarded_from,
          message_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        favoriteId,
        userId,
        source.id,
        source.conversation_id,
        source.conversation_title,
        source.sender_id,
        source.sender_name,
        source.sender_avatar_color,
        source.type,
        source.text_content,
        source.forwarded_from,
        source.created_at,
      ],
    );
    await client.query(
      `INSERT INTO favorite_attachments (favorite_id, attachment_id)
       SELECT $1, message_asset.attachment_id
         FROM (
           SELECT attachment.id AS attachment_id
             FROM attachments attachment
            WHERE attachment.message_id = $2 AND attachment.state = 'READY'
           UNION
           SELECT message_link.attachment_id
             FROM message_attachment_links message_link
             JOIN attachments linked_attachment
               ON linked_attachment.id = message_link.attachment_id
            WHERE message_link.message_id = $2 AND linked_attachment.state = 'READY'
         ) message_asset
       ON CONFLICT DO NOTHING`,
      [favoriteId, source.id],
    );

    const favorite = await findFavorite(userId, favoriteId, client);
    if (!favorite) throw new ApiError(500, "收藏记录创建失败");
    return { favorite, created: true };
  });
}

/** 取消收藏后，只有已经脱离原消息的最后一份附件引用才进入回收队列。 */
export async function removeMessageFavorite(userId: string, favoriteId: string): Promise<void> {
  await transaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id
         FROM message_favorites
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [favoriteId, userId],
    );
    const favorite = result.rows[0];
    if (!favorite) return;
    const attachmentResult = await client.query<{ attachment_id: string }>(
      `SELECT attachment_id
         FROM favorite_attachments
        WHERE favorite_id = $1`,
      [favoriteId],
    );
    await client.query("DELETE FROM message_favorites WHERE id = $1", [favoriteId]);
    await stageDetachedAttachmentsForCleanup(
      client,
      attachmentResult.rows.map((row) => row.attachment_id),
    );
  });
}
