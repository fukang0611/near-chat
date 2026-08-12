import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import {
  findMessage,
  listMessages,
  listMessagesAround,
  searchMessages,
} from "../message-service.js";
import {
  broadcastReceiptChanges,
  markConversationRead,
  markMessageDelivered,
} from "../receipt-service.js";
import { RealtimeHub } from "../realtime.js";

interface MemberRow {
  user_id: string;
}

interface ConversationMember {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
}

interface ConversationRow {
  id: string;
  type: "DIRECT" | "GROUP";
  name: string | null;
  avatar_color: string;
  members: ConversationMember[];
  last_message_type: "TEXT" | "IMAGE" | "FILE" | null;
  last_message_text: string | null;
  last_message_at: Date | null;
  last_message_sender_id: string | null;
  last_message_sender_name: string | null;
  unread_count: number;
}

const sendMessageSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    text: z.string().trim().max(5_000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .refine((value) => Boolean(value.text) || value.attachmentIds.length > 0, "消息内容不能为空");

const createGroupSchema = z.object({
  name: z.string().trim().min(2, "群聊名称至少 2 个字符").max(80),
  memberIds: z.array(z.string().uuid()).min(2, "请至少选择 2 位联系人").max(49),
});

const searchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const groupColors = ["#5B6EE1", "#6C5CE7", "#2F9E83", "#D97757", "#B65B7A", "#4477B8"];

async function ensureMember(conversationId: string, userId: string): Promise<void> {
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

function serializeConversation(row: ConversationRow, currentUserId: string, realtime: RealtimeHub) {
  const members = row.members.map((member) => ({
    ...member,
    online: realtime.isOnline(member.id),
  }));
  const peer = row.type === "DIRECT" ? members.find((member) => member.id !== currentUserId) : null;
  const title =
    row.type === "GROUP" ? (row.name ?? "未命名群聊") : (peer?.displayName ?? "未知用户");

  return {
    id: row.id,
    type: row.type,
    title,
    avatarColor: row.type === "GROUP" ? row.avatar_color : (peer?.avatarColor ?? row.avatar_color),
    peer: peer ?? null,
    members,
    memberCount: members.length,
    onlineMemberCount: members.filter((member) => member.online).length,
    lastMessage: row.last_message_type
      ? {
          type: row.last_message_type,
          text: row.last_message_text,
          createdAt: row.last_message_at?.toISOString() ?? null,
          senderId: row.last_message_sender_id,
          senderName: row.last_message_sender_name,
        }
      : null,
    unreadCount: row.unread_count,
  };
}

/** 会话路由模块：联系人、单聊与群聊、消息搜索、发送和精确回执。 */
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
              c.type,
              c.name,
              c.avatar_color,
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'id', member_user.id,
                            'username', member_user.username,
                            'displayName', member_user.display_name,
                            'avatarColor', member_user.avatar_color
                          )
                          ORDER BY member_user.display_name, member_user.username
                        )
                   FROM conversation_members all_members
                   JOIN users member_user ON member_user.id = all_members.user_id
                  WHERE all_members.conversation_id = c.id),
                '[]'::json
              ) AS members,
              last_message.type AS last_message_type,
              last_message.text_content AS last_message_text,
              last_message.created_at AS last_message_at,
              last_message.sender_id AS last_message_sender_id,
              last_message.sender_name AS last_message_sender_name,
              COALESCE(unread.count, 0)::int AS unread_count
         FROM conversations c
         JOIN conversation_members mine
           ON mine.conversation_id = c.id AND mine.user_id = $1
         LEFT JOIN LATERAL (
           SELECT m.type, m.text_content, m.created_at, m.sender_id, sender.display_name AS sender_name
             FROM messages m
             JOIN users sender ON sender.id = m.sender_id
            WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC
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
      conversations: result.rows.map((row) => serializeConversation(row, user.id, realtime)),
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
        `INSERT INTO conversations (id, type, direct_key, created_by)
           VALUES ($1, 'DIRECT', $2, $3)
           ON CONFLICT (direct_key)
           DO UPDATE SET direct_key = EXCLUDED.direct_key
           RETURNING id`,
        [randomUUID(), directKey, user.id],
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

    realtime.sendToUsers([user.id, peerId], {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(201).json({ conversationId });
  });

  router.post("/conversations/groups", authenticate, async (request, response) => {
    const user = currentUser(request);
    const input = createGroupSchema.parse(request.body);
    const memberIds = [...new Set(input.memberIds)].filter((memberId) => memberId !== user.id);
    if (memberIds.length < 2) throw new ApiError(400, "请至少选择 2 位不同的联系人");

    const eligibleMembers = await query<{ id: string }>(
      "SELECT id FROM users WHERE enabled = TRUE AND id = ANY($1::uuid[])",
      [memberIds],
    );
    if (eligibleMembers.rows.length !== memberIds.length) {
      throw new ApiError(400, "部分群成员不存在或已被禁用");
    }

    const conversationId = randomUUID();
    const colorIndex = Number.parseInt(conversationId.slice(0, 2), 16) % groupColors.length;
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO conversations (id, type, name, avatar_color, created_by)
         VALUES ($1, 'GROUP', $2, $3, $4)`,
        [conversationId, input.name, groupColors[colorIndex], user.id],
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         SELECT $1, unnest($2::uuid[])`,
        [conversationId, [user.id, ...memberIds]],
      );
    });

    realtime.sendToUsers([user.id, ...memberIds], {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(201).json({ conversationId });
  });

  router.get("/messages/search", authenticate, async (request, response) => {
    const user = currentUser(request);
    const input = searchSchema.parse(request.query);
    const messages = await searchMessages(
      user.id,
      input.q,
      input.conversationId ?? null,
      input.limit,
    );
    response.json({ messages });
  });

  router.get("/conversations/:conversationId/messages", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    await ensureMember(conversationId, user.id);

    const beforeRaw = z.string().datetime().optional().parse(request.query.before);
    const aroundMessageId = z.string().uuid().optional().parse(request.query.around);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    const messages = aroundMessageId
      ? await listMessagesAround(conversationId, aroundMessageId, limit)
      : await listMessages(conversationId, beforeRaw ? new Date(beforeRaw) : null, limit);
    if (aroundMessageId && messages.length === 0) throw new ApiError(404, "目标消息不存在");
    response.json({ messages });
  });

  router.post(
    "/conversations/:conversationId/messages",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const input = sendMessageSchema.parse(request.body);

      const saved = await transaction(async (client) => {
        const membership = await client.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, user.id],
        );
        if (membership.rowCount === 0) throw new ApiError(403, "无权访问该会话");

        let attachmentContentType: string | null = null;
        if (input.attachmentIds.length > 0) {
          const attachments = await client.query<{ id: string; content_type: string }>(
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

        // clientMessageId 是客户端重试的幂等键；冲突时只返回第一次写入的消息。
        const effectiveMessageId = inserted.rows[0]?.id;
        if (!effectiveMessageId) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM messages
              WHERE sender_id = $1 AND client_message_id = $2`,
            [user.id, input.clientMessageId],
          );
          const existingId = existing.rows[0]?.id;
          if (!existingId) throw new ApiError(500, "消息幂等记录读取失败");
          return { message: await findMessage(existingId, client), created: false };
        }

        if (input.attachmentIds.length > 0) {
          await client.query(`UPDATE attachments SET message_id = $1 WHERE id = ANY($2::uuid[])`, [
            effectiveMessageId,
            input.attachmentIds,
          ]);
        }
        await client.query(
          `INSERT INTO message_receipts (message_id, user_id)
           SELECT $1, user_id
             FROM conversation_members
            WHERE conversation_id = $2 AND user_id <> $3
           ON CONFLICT DO NOTHING`,
          [effectiveMessageId, conversationId, user.id],
        );
        return { message: await findMessage(effectiveMessageId, client), created: true };
      });

      if (!saved.message) throw new ApiError(500, "消息保存失败");
      let responseMessage = saved.message;

      if (saved.created) {
        const members = await conversationMemberIds(conversationId);
        const deliveredUsers = realtime
          .sendToUsers(members, {
            type: "message.created",
            payload: { message: saved.message },
          })
          .filter((memberId) => memberId !== user.id);
        const receiptChanges = await markMessageDelivered(saved.message.id, deliveredUsers);
        await broadcastReceiptChanges(realtime, receiptChanges);
        if (receiptChanges[0]) {
          responseMessage = { ...saved.message, receipt: receiptChanges[0].receipt };
        }
      }

      response.status(201).json({ message: responseMessage });
    },
  );

  router.post("/conversations/:conversationId/read", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const input = z
      .object({ throughMessageId: z.string().uuid().optional() })
      .parse(request.body ?? {});
    await ensureMember(conversationId, user.id);

    const changes = await markConversationRead(
      conversationId,
      user.id,
      input.throughMessageId ?? null,
    );
    await broadcastReceiptChanges(realtime, changes);
    const unread = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM messages m
         JOIN conversation_members mine
           ON mine.conversation_id = m.conversation_id AND mine.user_id = $2
        WHERE m.conversation_id = $1
          AND m.sender_id <> $2
          AND m.created_at > mine.last_read_at`,
      [conversationId, user.id],
    );
    const unreadCount = Number(unread.rows[0]?.count ?? 0);
    realtime.sendToUsers([user.id], {
      type: "unread.changed",
      payload: { conversationId, unreadCount },
    });
    response.json({ unreadCount });
  });

  return router;
}
