import { randomUUID } from "node:crypto";
import { transaction } from "./database.js";
import { isFlashRoomExpired } from "./flash-room-service.js";
import { ApiError } from "./http.js";
import type { MessageKind } from "./message-kind.js";
import { findMessage, type ForwardedMessageSourceDto, type MessageDto } from "./message-service.js";

export interface ForwardMessageItemInput {
  sourceMessageId: string;
  clientMessageId: string;
}

export interface ForwardedMessageResult {
  message: MessageDto;
  created: boolean;
}

interface ForwardSourceRow {
  id: string;
  type: MessageKind;
  text_content: string | null;
  created_at: Date;
  sender_name: string;
  conversation_title: string;
}

interface ExistingForwardRow {
  id: string;
  client_message_id: string;
  conversation_id: string;
}

/**
 * 按用户选中的顺序复制消息正文，并用引用表复用附件对象。
 * 整个批次在一个事务内完成：任一源消息失效时，目标会话不会留下半批消息。
 */
export async function forwardMessages(
  userId: string,
  targetConversationId: string,
  items: ForwardMessageItemInput[],
): Promise<ForwardedMessageResult[]> {
  return transaction(async (client) => {
    const targetResult = await client.query<{ expires_at: Date | null }>(
      `SELECT conversation.expires_at
         FROM conversations conversation
         JOIN conversation_members member
           ON member.conversation_id = conversation.id AND member.user_id = $2
        WHERE conversation.id = $1
        FOR SHARE OF conversation`,
      [targetConversationId, userId],
    );
    const target = targetResult.rows[0];
    if (!target) throw new ApiError(404, "目标会话不存在或无权访问");
    if (isFlashRoomExpired(target.expires_at)) {
      throw new ApiError(409, "目标闪聊已经结束，不能继续转发消息");
    }

    // 先按固定顺序取得整批幂等锁，避免两个交叉批次以相反顺序等待而死锁。
    const clientMessageIds = items.map((item) => item.clientMessageId);
    for (const clientMessageId of [...clientMessageIds].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        userId,
        clientMessageId,
      ]);
    }

    // 幂等记录必须先于源消息校验：首次已成功但响应丢失时，即使源消息随后
    // 被撤回，重试仍应返回第一次创建的目标消息，而不是留下误导性的失败。
    const existingResult = await client.query<ExistingForwardRow>(
      `SELECT id, client_message_id, conversation_id
         FROM messages
        WHERE sender_id = $1 AND client_message_id = ANY($2::uuid[])`,
      [userId, clientMessageIds],
    );
    if (existingResult.rows.some((row) => row.conversation_id !== targetConversationId)) {
      throw new ApiError(409, "转发幂等键已用于其他会话");
    }
    const existingByClientId = new Map(
      existingResult.rows.map((row) => [row.client_message_id, row]),
    );
    const pendingItems = items.filter((item) => !existingByClientId.has(item.clientMessageId));
    const sourceIds = pendingItems.map((item) => item.sourceMessageId);
    const sourceResult = await client.query<ForwardSourceRow>(
      `SELECT source_message.id,
              source_message.type,
              source_message.text_content,
              source_message.created_at,
              COALESCE(source_message.actor_name, source_sender.display_name) AS sender_name,
              CASE
                WHEN source_conversation.type = 'GROUP'
                  THEN COALESCE(source_conversation.name, '未命名群聊')
                ELSE COALESCE(
                  (SELECT peer.display_name
                     FROM conversation_members peer_member
                     JOIN users peer ON peer.id = peer_member.user_id
                    WHERE peer_member.conversation_id = source_conversation.id
                      AND peer_member.user_id <> $2
                    ORDER BY peer_member.joined_at
                    LIMIT 1),
                  '私聊'
                )
              END AS conversation_title
         FROM messages source_message
         JOIN conversations source_conversation
           ON source_conversation.id = source_message.conversation_id
         JOIN conversation_members source_member
           ON source_member.conversation_id = source_message.conversation_id
          AND source_member.user_id = $2
         JOIN users source_sender ON source_sender.id = source_message.sender_id
        WHERE source_message.id = ANY($1::uuid[])
          AND source_message.recalled_at IS NULL
        ORDER BY source_message.id
        FOR SHARE OF source_message`,
      [sourceIds, userId],
    );
    if (sourceResult.rows.length !== pendingItems.length) {
      throw new ApiError(400, "部分消息不存在、已撤回或无权转发");
    }
    const sourceById = new Map(sourceResult.rows.map((source) => [source.id, source]));

    const results: ForwardedMessageResult[] = [];
    for (const item of items) {
      const existing = existingByClientId.get(item.clientMessageId);
      if (existing) {
        const message = await findMessage(existing.id, client);
        if (!message) throw new ApiError(500, "转发消息读取失败");
        results.push({ message, created: false });
        continue;
      }

      const source = sourceById.get(item.sourceMessageId);
      if (!source) throw new ApiError(400, "转发源消息读取失败");

      const messageId = randomUUID();
      const forwardedFrom: ForwardedMessageSourceDto = {
        senderName: source.sender_name,
        conversationTitle: source.conversation_title,
        createdAt: source.created_at.toISOString(),
      };
      await client.query(
        `INSERT INTO messages
           (id, conversation_id, sender_id, client_message_id, type, text_content,
            forwarded_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          messageId,
          targetConversationId,
          userId,
          item.clientMessageId,
          source.type,
          source.text_content,
          forwardedFrom,
        ],
      );
      await client.query(
        `INSERT INTO message_attachment_links (message_id, attachment_id)
         SELECT $1, source_asset.attachment_id
           FROM (
             SELECT attachment.id AS attachment_id
               FROM attachments attachment
              WHERE attachment.message_id = $2 AND attachment.state = 'READY'
             UNION
             SELECT source_link.attachment_id
               FROM message_attachment_links source_link
               JOIN attachments linked_attachment
                 ON linked_attachment.id = source_link.attachment_id
              WHERE source_link.message_id = $2 AND linked_attachment.state = 'READY'
           ) source_asset
         ON CONFLICT DO NOTHING`,
        [messageId, source.id],
      );
      await client.query(
        `INSERT INTO message_receipts (message_id, user_id)
         SELECT $1, user_id
           FROM conversation_members
          WHERE conversation_id = $2 AND user_id <> $3
         ON CONFLICT DO NOTHING`,
        [messageId, targetConversationId, userId],
      );

      const message = await findMessage(messageId, client);
      if (!message) throw new ApiError(500, "转发消息创建失败");
      results.push({ message, created: true });
    }
    return results;
  });
}
