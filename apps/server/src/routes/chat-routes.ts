import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { recordAudit } from "../audit-service.js";
import { publicAvatarUrl } from "../avatar-service.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { isAllowedFlashRoomExpiry, isFlashRoomExpired } from "../flash-room-service.js";
import { messageKindFromContentType, type MessageKind } from "../message-kind.js";
import {
  decodeMessageCursor,
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
import { MESSAGE_REACTION_EMOJIS } from "../reaction-service.js";
import { RealtimeHub } from "../realtime.js";
import { activeUserStatus } from "../status-service.js";

interface MemberRow {
  user_id: string;
}

interface DirectPeerRow {
  id: string;
  display_name: string;
}

interface ConversationMember {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarObjectKey: string | null;
  avatarVersion: number;
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: string | null;
}

interface ConversationRow {
  id: string;
  type: "DIRECT" | "GROUP";
  name: string | null;
  avatar_color: string;
  owner_id: string | null;
  expires_at: Date | null;
  members: ConversationMember[];
  last_message_type: MessageKind | null;
  last_message_text: string | null;
  last_message_at: Date | null;
  last_message_sender_id: string | null;
  last_message_sender_name: string | null;
  last_message_recalled_at: Date | null;
  unread_count: number;
}

const sendMessageSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    text: z.string().trim().max(5_000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(5).default([]),
    replyToMessageId: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.text) || value.attachmentIds.length > 0, "消息内容不能为空");

const createGroupSchema = z
  .object({
    name: z.string().trim().min(2, "群聊名称至少 2 个字符").max(80),
    memberIds: z.array(z.string().uuid()).min(2, "请至少选择 2 位联系人").max(49),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, context) => {
    if (value.expiresAt && !isAllowedFlashRoomExpiry(new Date(value.expiresAt))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "闪聊有效期需在 5 分钟至 7 天之间",
      });
    }
  });

const groupColors = ["#5B6EE1", "#6C5CE7", "#2F9E83", "#D97757", "#B65B7A", "#4477B8"] as const;

const updateGroupSchema = z
  .object({
    name: z.string().trim().min(2, "群聊名称至少 2 个字符").max(80).optional(),
    avatarColor: z.enum(groupColors).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "没有可更新的群资料");

const groupMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1, "请选择要添加的联系人").max(49),
});

const transferOwnerSchema = z.object({ userId: z.string().uuid() });

const searchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const reactionSchema = z.object({ emoji: z.enum(MESSAGE_REACTION_EMOJIS) });

async function ensureMember(conversationId: string, userId: string): Promise<void> {
  const result = await query(
    `SELECT 1
       FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (result.rowCount === 0) throw new ApiError(403, "无权访问该会话");
}

interface LockedGroupRow {
  id: string;
  name: string;
  owner_id: string | null;
}

/** 群管理操作统一先锁定群记录，确保群主转让、退群和解散不会交叉覆盖。 */
async function lockGroup(
  client: PoolClient,
  conversationId: string,
  userId: string,
  ownerRequired = false,
): Promise<LockedGroupRow> {
  const result = await client.query<LockedGroupRow>(
    `SELECT c.id, c.name, c.owner_id
       FROM conversations c
       JOIN conversation_members member
         ON member.conversation_id = c.id AND member.user_id = $2
      WHERE c.id = $1 AND c.type = 'GROUP'
      FOR UPDATE OF c`,
    [conversationId, userId],
  );
  const group = result.rows[0];
  if (!group) throw new ApiError(404, "群聊不存在或你已不在群内");
  if (ownerRequired && group.owner_id !== userId) {
    throw new ApiError(403, "只有群主可以执行此操作");
  }
  return group;
}

/**
 * 删除群聊前先解除附件外键并标记回收，保留 MinIO 删除失败后的重试依据。
 * 消息随后级联删除，但附件元数据会一直保留到对象确认删除。
 */
async function stageConversationAttachmentsForCleanup(
  client: PoolClient,
  conversationId: string,
): Promise<void> {
  await client.query(
    `UPDATE attachments attachment
        SET message_id = NULL,
            state = 'CLEANUP_FAILED',
            state_updated_at = NOW()
       FROM messages message
      WHERE attachment.message_id = message.id
        AND message.conversation_id = $1`,
    [conversationId],
  );
}

async function conversationMemberIds(conversationId: string): Promise<string[]> {
  const result = await query<MemberRow>(
    "SELECT user_id FROM conversation_members WHERE conversation_id = $1",
    [conversationId],
  );
  return result.rows.map((row) => row.user_id);
}

function serializeConversation(row: ConversationRow, currentUserId: string, realtime: RealtimeHub) {
  const members = row.members.map(
    ({ avatarObjectKey, avatarVersion, statusText, statusEmoji, statusExpiresAt, ...member }) => ({
      ...member,
      avatarUrl: publicAvatarUrl(member.id, avatarObjectKey, avatarVersion),
      status: activeUserStatus(statusText, statusEmoji, statusExpiresAt),
      online: realtime.isOnline(member.id),
    }),
  );
  const peer = row.type === "DIRECT" ? members.find((member) => member.id !== currentUserId) : null;
  const title =
    row.type === "GROUP" ? (row.name ?? "未命名群聊") : (peer?.displayName ?? "未知用户");

  return {
    id: row.id,
    type: row.type,
    title,
    avatarColor: row.type === "GROUP" ? row.avatar_color : (peer?.avatarColor ?? row.avatar_color),
    avatarUrl: row.type === "DIRECT" ? (peer?.avatarUrl ?? null) : null,
    ownerId: row.type === "GROUP" ? row.owner_id : null,
    expiresAt: row.expires_at?.toISOString() ?? null,
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
          recalled: Boolean(row.last_message_recalled_at),
        }
      : null,
    unreadCount: row.unread_count,
  };
}

/** 会话路由模块：联系人、单聊与群聊、消息搜索、发送和精确回执。 */
export function createChatRouter(realtime: RealtimeHub) {
  const router = Router();
  // “敲一下”不落库，只保留进程内的短暂冷却，避免连续点击打扰对方。
  const lastNudgeAt = new Map<string, number>();

  router.get("/users", authenticate, async (request, response) => {
    const user = currentUser(request);
    const result = await query<{
      id: string;
      username: string;
      display_name: string;
      avatar_color: string;
      avatar_object_key: string | null;
      avatar_version: number;
      status_text: string | null;
      status_emoji: string | null;
      status_expires_at: Date | null;
    }>(
      `SELECT id, username, display_name, avatar_color, avatar_object_key, avatar_version,
              status_text, status_emoji, status_expires_at
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
        avatarUrl: publicAvatarUrl(row.id, row.avatar_object_key, row.avatar_version),
        status: activeUserStatus(row.status_text, row.status_emoji, row.status_expires_at),
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
              c.owner_id,
              c.expires_at,
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'id', member_user.id,
                            'username', member_user.username,
                            'displayName', member_user.display_name,
                            'avatarColor', member_user.avatar_color,
                            'avatarObjectKey', member_user.avatar_object_key,
                            'avatarVersion', member_user.avatar_version,
                            'statusText', member_user.status_text,
                            'statusEmoji', member_user.status_emoji,
                            'statusExpiresAt', member_user.status_expires_at
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
              last_message.recalled_at AS last_message_recalled_at,
              COALESCE(unread.count, 0)::int AS unread_count
         FROM conversations c
         JOIN conversation_members mine
           ON mine.conversation_id = c.id AND mine.user_id = $1
         LEFT JOIN LATERAL (
           SELECT m.type,
                  CASE WHEN m.recalled_at IS NULL THEN m.text_content ELSE NULL END AS text_content,
                  m.created_at,
                  m.sender_id,
                  m.recalled_at,
                  sender.display_name AS sender_name
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
              AND m.recalled_at IS NULL
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

  router.post("/conversations/:conversationId/nudge", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const peerResult = await query<DirectPeerRow>(
      `SELECT peer.id, peer.display_name
         FROM conversations conversation
         JOIN conversation_members mine
           ON mine.conversation_id = conversation.id AND mine.user_id = $2
         JOIN conversation_members peer_member
           ON peer_member.conversation_id = conversation.id AND peer_member.user_id <> $2
         JOIN users peer ON peer.id = peer_member.user_id AND peer.enabled = TRUE
        WHERE conversation.id = $1 AND conversation.type = 'DIRECT'`,
      [conversationId, user.id],
    );
    const peer = peerResult.rows[0];
    if (!peer) throw new ApiError(404, "单聊不存在或联系人已不可用");
    if (!realtime.isOnline(peer.id)) throw new ApiError(409, `${peer.display_name} 当前不在线`);

    const cooldownKey = `${user.id}:${peer.id}`;
    const now = Date.now();
    if (now - (lastNudgeAt.get(cooldownKey) ?? 0) < 3_000) {
      throw new ApiError(429, "刚刚已经敲过了，稍等一下吧");
    }

    const delivered = realtime.sendToUsers([peer.id], {
      type: "nudge.received",
      payload: {
        id: randomUUID(),
        conversationId,
        senderId: user.id,
        senderName: user.displayName,
        senderAvatarColor: user.avatarColor,
        senderAvatarUrl: publicAvatarUrl(user.id, user.avatarObjectKey, user.avatarVersion),
        createdAt: new Date(now).toISOString(),
      },
    });
    if (delivered.length === 0) throw new ApiError(409, `${peer.display_name} 刚刚离线了`);
    lastNudgeAt.set(cooldownKey, now);
    response.status(204).send();
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
        `INSERT INTO conversations
           (id, type, name, avatar_color, created_by, owner_id, expires_at)
         VALUES ($1, 'GROUP', $2, $3, $4, $4, $5)`,
        [conversationId, input.name, groupColors[colorIndex], user.id, input.expiresAt ?? null],
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         SELECT $1, unnest($2::uuid[])`,
        [conversationId, [user.id, ...memberIds]],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: input.expiresAt ? "FLASH_ROOM_CREATE" : "GROUP_CREATE",
          targetType: "CONVERSATION",
          targetId: conversationId,
          details: { name: input.name, memberIds, expiresAt: input.expiresAt ?? null },
        },
        client,
      );
    });

    realtime.sendToUsers([user.id, ...memberIds], {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(201).json({ conversationId });
  });

  router.patch("/conversations/:conversationId/group", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const input = updateGroupSchema.parse(request.body);

    await transaction(async (client) => {
      await lockGroup(client, conversationId, user.id, true);
      await client.query(
        `UPDATE conversations
            SET name = COALESCE($2, name),
                avatar_color = COALESCE($3, avatar_color),
                updated_at = NOW()
          WHERE id = $1`,
        [conversationId, input.name ?? null, input.avatarColor ?? null],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: "GROUP_PROFILE_UPDATE",
          targetType: "CONVERSATION",
          targetId: conversationId,
          details: input,
        },
        client,
      );
    });

    realtime.sendToUsers(await conversationMemberIds(conversationId), {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(204).end();
  });

  router.post("/conversations/:conversationId/members", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const input = groupMembersSchema.parse(request.body);
    const requestedIds = [...new Set(input.memberIds)].filter((id) => id !== user.id);
    if (requestedIds.length === 0) throw new ApiError(400, "请选择尚未加入群聊的联系人");

    const addedIds = await transaction(async (client) => {
      await lockGroup(client, conversationId, user.id, true);
      const count = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
             FROM conversation_members
            WHERE conversation_id = $1`,
        [conversationId],
      );
      const existing = await client.query<{ id: string }>(
        `SELECT member_id.id
             FROM unnest($1::uuid[]) AS member_id(id)
             JOIN users candidate ON candidate.id = member_id.id AND candidate.enabled = TRUE
            WHERE NOT EXISTS (
              SELECT 1 FROM conversation_members current_member
               WHERE current_member.conversation_id = $2
                 AND current_member.user_id = member_id.id
            )`,
        [requestedIds, conversationId],
      );
      const newIds = existing.rows.map((row) => row.id);
      if (newIds.length !== requestedIds.length) {
        throw new ApiError(400, "部分联系人不存在、已禁用或已在群内");
      }
      if (Number(count.rows[0]?.count ?? 0) + newIds.length > 50) {
        throw new ApiError(400, "群聊最多包含 50 位成员");
      }
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
           SELECT $1, unnest($2::uuid[])`,
        [conversationId, newIds],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: "GROUP_MEMBERS_ADD",
          targetType: "CONVERSATION",
          targetId: conversationId,
          details: { memberIds: newIds },
        },
        client,
      );
      return newIds;
    });

    realtime.sendToUsers(await conversationMemberIds(conversationId), {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(201).json({ addedIds });
  });

  router.delete(
    "/conversations/:conversationId/members/:userId",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const targetUserId = z.string().uuid().parse(request.params.userId);
      const previousMemberIds = await conversationMemberIds(conversationId);

      await transaction(async (client) => {
        const group = await lockGroup(client, conversationId, user.id, true);
        if (group.owner_id === targetUserId) throw new ApiError(400, "群主不能被移出群聊");
        const removed = await client.query(
          `DELETE FROM conversation_members
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, targetUserId],
        );
        if (removed.rowCount === 0) throw new ApiError(404, "该用户不在群聊中");
        await client.query(
          `DELETE FROM message_receipts receipt
           USING messages message
           WHERE receipt.message_id = message.id
             AND message.conversation_id = $1
             AND receipt.user_id = $2`,
          [conversationId, targetUserId],
        );
        await recordAudit(
          {
            actorId: user.id,
            action: "GROUP_MEMBER_REMOVE",
            targetType: "CONVERSATION",
            targetId: conversationId,
            details: { userId: targetUserId },
          },
          client,
        );
      });

      realtime.sendToUsers(previousMemberIds, {
        type: "conversation.changed",
        payload: { conversationId },
      });
      response.status(204).end();
    },
  );

  router.post(
    "/conversations/:conversationId/transfer-owner",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const input = transferOwnerSchema.parse(request.body);
      if (input.userId === user.id) throw new ApiError(400, "你已经是群主");

      await transaction(async (client) => {
        await lockGroup(client, conversationId, user.id, true);
        const member = await client.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, input.userId],
        );
        if (member.rowCount === 0) throw new ApiError(400, "新群主必须是群成员");
        await client.query(
          `UPDATE conversations SET owner_id = $2, updated_at = NOW() WHERE id = $1`,
          [conversationId, input.userId],
        );
        await recordAudit(
          {
            actorId: user.id,
            action: "GROUP_OWNER_TRANSFER",
            targetType: "CONVERSATION",
            targetId: conversationId,
            details: { ownerId: input.userId },
          },
          client,
        );
      });

      realtime.sendToUsers(await conversationMemberIds(conversationId), {
        type: "conversation.changed",
        payload: { conversationId },
      });
      response.status(204).end();
    },
  );

  router.post("/conversations/:conversationId/leave", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const previousMemberIds = await conversationMemberIds(conversationId);

    const result = await transaction(async (client) => {
      const group = await lockGroup(client, conversationId, user.id);
      let nextOwnerId: string | null = null;
      if (group.owner_id === user.id) {
        const successor = await client.query<{ user_id: string }>(
          `SELECT user_id
             FROM conversation_members
            WHERE conversation_id = $1 AND user_id <> $2
            ORDER BY joined_at, user_id
            LIMIT 1`,
          [conversationId, user.id],
        );
        nextOwnerId = successor.rows[0]?.user_id ?? null;
        if (!nextOwnerId) {
          await stageConversationAttachmentsForCleanup(client, conversationId);
          await client.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
          await recordAudit(
            {
              actorId: user.id,
              action: "GROUP_DISBAND",
              targetType: "CONVERSATION",
              targetId: conversationId,
              details: { reason: "last_owner_left" },
            },
            client,
          );
          return { dissolved: true, nextOwnerId: null };
        }
        await client.query(
          "UPDATE conversations SET owner_id = $2, updated_at = NOW() WHERE id = $1",
          [conversationId, nextOwnerId],
        );
      }
      await client.query(
        `DELETE FROM message_receipts receipt
         USING messages message
         WHERE receipt.message_id = message.id
           AND message.conversation_id = $1
           AND receipt.user_id = $2`,
        [conversationId, user.id],
      );
      await client.query(
        "DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, user.id],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: "GROUP_LEAVE",
          targetType: "CONVERSATION",
          targetId: conversationId,
          details: { nextOwnerId },
        },
        client,
      );
      return { dissolved: false, nextOwnerId };
    });

    realtime.sendToUsers(previousMemberIds, {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.json(result);
  });

  router.delete("/conversations/:conversationId", authenticate, async (request, response) => {
    const user = currentUser(request);
    const conversationId = z.string().uuid().parse(request.params.conversationId);
    const previousMemberIds = await conversationMemberIds(conversationId);

    await transaction(async (client) => {
      const group = await lockGroup(client, conversationId, user.id, true);
      await stageConversationAttachmentsForCleanup(client, conversationId);
      await client.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      await recordAudit(
        {
          actorId: user.id,
          action: "GROUP_DISBAND",
          targetType: "CONVERSATION",
          targetId: conversationId,
          details: { name: group.name },
        },
        client,
      );
    });

    realtime.sendToUsers(previousMemberIds, {
      type: "conversation.changed",
      payload: { conversationId },
    });
    response.status(204).end();
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
    const cursorRaw = z.string().max(512).optional().parse(request.query.cursor);
    const aroundMessageId = z.string().uuid().optional().parse(request.query.around);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    const cursor = cursorRaw ? decodeMessageCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) throw new ApiError(400, "消息游标无效");
    const page = aroundMessageId
      ? await listMessagesAround(conversationId, aroundMessageId, limit)
      : await listMessages(conversationId, cursor, limit, beforeRaw ? new Date(beforeRaw) : null);
    if (aroundMessageId && page.messages.length === 0) {
      throw new ApiError(404, "目标消息不存在");
    }
    response.json(page);
  });

  router.post(
    "/conversations/:conversationId/messages",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const input = sendMessageSchema.parse(request.body);

      const saved = await transaction(async (client) => {
        const membership = await client.query<{ expires_at: Date | null }>(
          `SELECT conversation.expires_at
             FROM conversation_members member
             JOIN conversations conversation ON conversation.id = member.conversation_id
            WHERE member.conversation_id = $1 AND member.user_id = $2`,
          [conversationId, user.id],
        );
        if (membership.rowCount === 0) throw new ApiError(403, "无权访问该会话");

        // 幂等键必须先于附件和引用校验：首次请求已经成功但响应丢失时，
        // 附件可能已经绑定、引用源也可能随后被撤回，重试仍应返回第一次结果。
        // 事务级锁同时覆盖并发重复请求，避免第二个请求在附件刚绑定后误报失效。
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          user.id,
          input.clientMessageId,
        ]);
        const existingMessage = await client.query<{ id: string }>(
          `SELECT id FROM messages
            WHERE sender_id = $1 AND client_message_id = $2`,
          [user.id, input.clientMessageId],
        );
        if (existingMessage.rows[0]) {
          return {
            message: await findMessage(existingMessage.rows[0].id, client),
            created: false,
          };
        }

        if (isFlashRoomExpired(membership.rows[0].expires_at)) {
          throw new ApiError(409, "闪聊房间已结束，现在只能查看历史消息");
        }

        if (input.replyToMessageId) {
          const replyTarget = await client.query(
            `SELECT 1
               FROM messages
              WHERE id = $1
                AND conversation_id = $2
                AND recalled_at IS NULL`,
            [input.replyToMessageId, conversationId],
          );
          if (replyTarget.rowCount === 0) {
            throw new ApiError(400, "引用的消息不存在或已被撤回");
          }
        }

        let attachmentContentType: string | null = null;
        if (input.attachmentIds.length > 0) {
          const attachments = await client.query<{ id: string; content_type: string }>(
            `SELECT id, content_type
               FROM attachments
              WHERE id = ANY($1::uuid[])
                AND uploader_id = $2
                AND message_id IS NULL
                AND state = 'READY'
              FOR UPDATE`,
            [input.attachmentIds, user.id],
          );
          if (attachments.rows.length !== input.attachmentIds.length) {
            throw new ApiError(400, "附件不存在、已使用或不属于当前用户");
          }
          attachmentContentType = attachments.rows[0]?.content_type ?? null;
        }

        const type = messageKindFromContentType(attachmentContentType);
        const messageId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO messages
             (id, conversation_id, sender_id, client_message_id, type, text_content,
              reply_to_message_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (sender_id, client_message_id) DO NOTHING
           RETURNING id`,
          [
            messageId,
            conversationId,
            user.id,
            input.clientMessageId,
            type,
            input.text || null,
            input.replyToMessageId ?? null,
          ],
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

  router.post(
    "/conversations/:conversationId/messages/:messageId/reactions",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const messageId = z.string().uuid().parse(request.params.messageId);
      const { emoji } = reactionSchema.parse(request.body);

      const toggled = await transaction(async (client) => {
        // 锁住消息可同时串行化撤回与反应切换，避免给刚撤回的消息留下新反应。
        const target = await client.query<{
          recalled_at: Date | null;
          expires_at: Date | null;
        }>(
          `SELECT message.recalled_at, conversation.expires_at
             FROM messages message
             JOIN conversations conversation ON conversation.id = message.conversation_id
             JOIN conversation_members member
               ON member.conversation_id = conversation.id AND member.user_id = $3
            WHERE message.id = $1 AND message.conversation_id = $2
            FOR UPDATE OF message`,
          [messageId, conversationId, user.id],
        );
        const message = target.rows[0];
        if (!message) throw new ApiError(404, "消息不存在或无权访问");
        if (message.recalled_at) throw new ApiError(409, "已撤回的消息不能添加反应");
        if (isFlashRoomExpired(message.expires_at)) {
          throw new ApiError(409, "闪聊房间已结束，现在只能查看历史消息");
        }

        const removed = await client.query(
          `DELETE FROM message_reactions
            WHERE message_id = $1 AND user_id = $2 AND emoji = $3
          RETURNING message_id`,
          [messageId, user.id, emoji],
        );
        const active = removed.rowCount === 0;
        if (active) {
          await client.query(
            `INSERT INTO message_reactions (message_id, user_id, emoji)
             VALUES ($1, $2, $3)`,
            [messageId, user.id, emoji],
          );
        }

        return { message: await findMessage(messageId, client), active };
      });

      if (!toggled.message) throw new ApiError(500, "消息反应同步失败");
      const members = await conversationMemberIds(conversationId);
      realtime.sendToUsers(members, {
        type: "message.updated",
        payload: { message: toggled.message },
      });
      response.json(toggled);
    },
  );

  router.post(
    "/conversations/:conversationId/messages/:messageId/recall",
    authenticate,
    async (request, response) => {
      const user = currentUser(request);
      const conversationId = z.string().uuid().parse(request.params.conversationId);
      const messageId = z.string().uuid().parse(request.params.messageId);

      const recalled = await transaction(async (client) => {
        const membership = await client.query(
          `SELECT 1 FROM conversation_members
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, user.id],
        );
        if (membership.rowCount === 0) throw new ApiError(403, "无权访问该会话");

        const result = await client.query<{
          sender_id: string;
          created_at: Date;
          recalled_at: Date | null;
          recall_expired: boolean;
        }>(
          `SELECT sender_id,
                  created_at,
                  recalled_at,
                  created_at + ($3::int * INTERVAL '1 second') < NOW() AS recall_expired
             FROM messages
            WHERE id = $1 AND conversation_id = $2
            FOR UPDATE`,
          [messageId, conversationId, config.messageRecallWindowSeconds],
        );
        const message = result.rows[0];
        if (!message) throw new ApiError(404, "消息不存在");
        if (message.sender_id !== user.id) throw new ApiError(403, "只能撤回自己发送的消息");

        // 重复请求返回同一结果，使客户端在响应丢失后可以安全重试。
        if (message.recalled_at) {
          return { message: await findMessage(messageId, client), changed: false };
        }
        if (message.recall_expired) {
          throw new ApiError(409, "已超过消息撤回时限");
        }

        // 先解除附件关系并进入回收队列，撤回成功后原文件立即不可从消息访问。
        await client.query(
          `UPDATE attachments
              SET message_id = NULL,
                  state = 'CLEANUP_FAILED',
                  state_updated_at = NOW()
            WHERE message_id = $1`,
          [messageId],
        );
        await client.query(
          `UPDATE messages
              SET text_content = NULL,
                  recalled_at = NOW()
            WHERE id = $1`,
          [messageId],
        );
        await client.query("DELETE FROM message_reactions WHERE message_id = $1", [messageId]);
        return { message: await findMessage(messageId, client), changed: true };
      });

      if (!recalled.message) throw new ApiError(500, "撤回结果读取失败");
      if (recalled.changed) {
        const members = await conversationMemberIds(conversationId);
        realtime.sendToUsers(members, {
          type: "message.updated",
          payload: { message: recalled.message },
        });
      }
      response.json({ message: recalled.message });
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
          AND m.recalled_at IS NULL
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
