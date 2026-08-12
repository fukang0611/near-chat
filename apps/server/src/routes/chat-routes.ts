import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { findMessage, listMessages } from "../message-service.js";
import { RealtimeHub } from "../realtime.js";

interface MemberRow {
  user_id: string;
}

interface ConversationRow {
  id: string;
  peer_id: string;
  peer_username: string;
  peer_name: string;
  peer_avatar_color: string;
  last_message_type: "TEXT" | "IMAGE" | "FILE" | null;
  last_message_text: string | null;
  last_message_at: Date | null;
  unread_count: number;
}

const sendMessageSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    text: z.string().trim().max(5_000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .refine((value) => Boolean(value.text) || value.attachmentIds.length > 0, "消息内容不能为空");

async function ensureMember(conversationId: string, userId: string) {
  const result = await query(
    `SELECT 1
       FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (result.rowCount === 0) throw new ApiError(403, "无权访问该会话");
}

async function conversationMemberIds(conversationId: string): Promise<string[]> {
  const result = await query<MemberRow>(
    "SELECT user_id FROM conversation_members WHERE conversation_id = $1",
    [conversationId],
  );
  return result.rows.map((row) => row.user_id);
}

/** 会话路由模块：联系人发现、单聊建立、消息历史、发送与已读状态。 */
export function createChatRouter(realtime: RealtimeHub) {
  const router = Router();

  router.get("/users", authenticate, async (request, response) => {
    const user = currentUser(request);
    const result = await query<{
      id: string;
      username: string;
      display_name: string;
      avatar_color: string;
    }>(
      `SELECT id, username, display_name, avatar_color
         FROM users
        WHERE enabled = TRUE AND id <> $1
        ORDER BY display_name, username`,
      [user.id],
    );
    response.json({
      users: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarColor: row.avatar_color,
        online: realtime.isOnline(row.id),
      })),
    });
  });

  router.get("/conversations", authenticate, async (request, response) => {
    const user = currentUser(request);
    const result = await query<ConversationRow>(
      `SELECT c.id,
              peer_user.id AS peer_id,
              peer_user.username AS peer_username,
              peer_user.display_name AS peer_name,
              peer_user.avatar_color AS peer_avatar_color,
              last_message.type AS last_message_type,
              last_message.text_content AS last_message_text,
              last_message.created_at AS last_message_at,
              COALESCE(unread.count, 0)::int AS unread_count
         FROM conversations c
         JOIN conversation_members mine
           ON mine.conversation_id = c.id AND mine.user_id = $1
         JOIN conversation_members peer
           ON peer.conversation_id = c.id AND peer.user_id <> $1
         JOIN users peer_user ON peer_user.id = peer.user_id
         LEFT JOIN LATERAL (
           SELECT type, text_content, created_at
             FROM messages
            WHERE conversation_id = c.id
            ORDER BY created_at DESC
            LIMIT 1
         ) last_message ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count
             FROM messages m
            WHERE m.conversation_id = c.id
              AND m.sender_id <> $1
              AND m.created_at > mine.last_read_at
         ) unread ON TRUE
        ORDER BY last_message.created_at DESC NULLS LAST, c.created_at DESC`,
      [user.id],
    );

    response.json({
      conversations: result.rows.map((row) => ({
        id: row.id,
        peer: {
          id: row.peer_id,
          username: row.peer_username,
          displayName: row.peer_name,
          avatarColor: row.peer_avatar_color,
          online: realtime.isOnline(row.peer_id),
        },
        lastMessage: row.last_message_type
          ? {
              type: row.last_message_type,
              text: row.last_message_text,
              createdAt: row.last_message_at?.toISOString() ?? null,
            }
          : null,
        unreadCount: row.unread_count,
      })),
    });
  });

  router.post("/conversations/direct/:userId", authenticate, async (request, response) => {
    const user = currentUser(request);
    const peerId = z.string().uuid().parse(request.params.userId);
    if (peerId === user.id) throw new ApiError(400, "不能和自己创建会话");

    const peer = await query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND enabled = TRUE",
      [peerId],
    );
    if (!peer.rows[0]) throw new ApiError(404, "用户不存在或已被禁用");

    // 排序后的用户 ID 是单聊的稳定业务键，可并发安全地复用同一会话。
    const directKey = [user.id, peerId].sort().join(":");
    const conversationId = await transaction(async (client) => {
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO conversations (id, type, direct_key)
           VALUES ($1, 'DIRECT', $2)
           ON CONFLICT (direct_key)
           DO UPDATE SET direct_key = EXCLUDED.direct_key
           RETURNING id`,
        [randomUUID(), directKey],
      );
      const id = conversation.rows[0].id;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
           VALUES ($1, $2), ($1, $3)
           ON CONFLICT DO NOTHING`,
        [id, user.id, peerId],
      );
      return id;
    });

    response.status(201).json({ conversationId });
  });

  router.get("/conversations/:conversationId/messages", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    await ensureMember(conversationId, user.id);

    const beforeRaw = z.string().datetime().optional().parse(request.query.before);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    const messages = await listMessages(
      conversationId,
      beforeRaw ? new Date(beforeRaw) : null,
      limit,
    );
    response.json({ messages });
  });

  router.post(
    "/conversations/:conversationId/messages",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const input = sendMessageSchema.parse(request.body);

      const message = await transaction(async (client) => {
        const membership = await client.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, user.id],
        );
        if (membership.rowCount === 0) {
          throw new ApiError(403, "无权访问该会话");
        }

        let attachmentContentType: string | null = null;
        if (input.attachmentIds.length > 0) {
          const attachments = await client.query<{
            id: string;
            content_type: string;
          }>(
            `SELECT id, content_type
               FROM attachments
              WHERE id = ANY($1::uuid[])
                AND uploader_id = $2
                AND message_id IS NULL`,
            [input.attachmentIds, user.id],
          );
          if (attachments.rows.length !== input.attachmentIds.length) {
            throw new ApiError(400, "附件不存在、已使用或不属于当前用户");
          }
          attachmentContentType = attachments.rows[0]?.content_type ?? null;
        }

        const type = attachmentContentType
          ? attachmentContentType.startsWith("image/")
            ? "IMAGE"
            : "FILE"
          : "TEXT";
        const messageId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO messages
             (id, conversation_id, sender_id, client_message_id, type, text_content)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (sender_id, client_message_id) DO NOTHING
           RETURNING id`,
          [messageId, conversationId, user.id, input.clientMessageId, type, input.text || null],
        );

        // clientMessageId 是客户端重试的幂等键；冲突时返回第一次写入的消息。
        const effectiveMessageId = inserted.rows[0]?.id;
        if (!effectiveMessageId) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM messages
              WHERE sender_id = $1 AND client_message_id = $2`,
            [user.id, input.clientMessageId],
          );
          const existingId = existing.rows[0]?.id;
          if (!existingId) throw new ApiError(500, "消息幂等记录读取失败");
          return findMessage(existingId, client);
        }

        if (input.attachmentIds.length > 0) {
          await client.query(
            `UPDATE attachments
                SET message_id = $1
              WHERE id = ANY($2::uuid[])`,
            [effectiveMessageId, input.attachmentIds],
          );
        }
        return findMessage(effectiveMessageId, client);
      });

      if (!message) throw new ApiError(500, "消息保存失败");
      const members = await conversationMemberIds(conversationId);
      realtime.sendToUsers(members, {
        type: "message.created",
        payload: { message },
      });
      response.status(201).json({ message });
    },
  );

  router.post("/conversations/:conversationId/read", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const result = await query(
      `UPDATE conversation_members
            SET last_read_at = NOW()
          WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, user.id],
    );
    if (result.rowCount === 0) throw new ApiError(403, "无权访问该会话");
    realtime.sendToUsers([user.id], {
      type: "unread.changed",
      payload: { conversationId, unreadCount: 0 },
    });
    response.status(204).end();
  });

  return router;
}
