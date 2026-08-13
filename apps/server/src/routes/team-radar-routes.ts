import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { publicAvatarUrl } from "../avatar-service.js";
import { query } from "../database.js";
import { currentUser } from "../http.js";
import type { MessageKind } from "../message-kind.js";
import { RealtimeHub } from "../realtime.js";
import { activeUserStatus } from "../status-service.js";
import { teamDayWindow } from "../team-radar-service.js";

interface RadarMemberRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_object_key: string | null;
  avatar_version: number;
  status_text: string | null;
  status_emoji: string | null;
  status_expires_at: Date | null;
}

interface ActiveConversationRow {
  conversation_id: string;
  message_count: number;
  last_activity_at: Date;
  last_message_type: MessageKind;
  last_message_text: string | null;
  last_sender_name: string;
}

interface UnreadConversationRow {
  conversation_id: string;
  unread_count: number;
  latest_unread_at: Date;
  last_message_type: MessageKind;
  last_message_text: string | null;
  last_sender_name: string;
}

const radarQuerySchema = z.object({
  timezoneOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});

/** 只汇总当前账号可见的会话；成员在线信息沿用近聊已有团队通讯录边界。 */
export function createTeamRadarRouter(realtime: RealtimeHub) {
  const router = Router();

  router.get("/team/radar", authenticate, async (request, response) => {
    const user = currentUser(request);
    const { timezoneOffsetMinutes } = radarQuerySchema.parse(request.query);
    const { start, end } = teamDayWindow(timezoneOffsetMinutes);

    const [members, activeConversations, unreadConversations] = await Promise.all([
      query<RadarMemberRow>(
        `SELECT id, username, display_name, avatar_color, avatar_object_key, avatar_version,
                status_text, status_emoji, status_expires_at
           FROM users
          WHERE enabled = TRUE
          ORDER BY display_name, username`,
      ),
      query<ActiveConversationRow>(
        `SELECT message.conversation_id,
                COUNT(*)::int AS message_count,
                MAX(message.created_at) AS last_activity_at,
                (ARRAY_AGG(message.type ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_message_type,
                (ARRAY_AGG(message.text_content ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_message_text,
                (ARRAY_AGG(sender.display_name ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_sender_name
           FROM messages message
           JOIN conversation_members mine
             ON mine.conversation_id = message.conversation_id AND mine.user_id = $1
           JOIN users sender ON sender.id = message.sender_id
          WHERE message.created_at >= $2
            AND message.created_at < $3
            AND message.recalled_at IS NULL
          GROUP BY message.conversation_id
          ORDER BY last_activity_at DESC`,
        [user.id, start.toISOString(), end.toISOString()],
      ),
      query<UnreadConversationRow>(
        `SELECT mine.conversation_id,
                COUNT(message.id)::int AS unread_count,
                MAX(message.created_at) AS latest_unread_at,
                (ARRAY_AGG(message.type ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_message_type,
                (ARRAY_AGG(message.text_content ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_message_text,
                (ARRAY_AGG(sender.display_name ORDER BY message.created_at DESC, message.id DESC))[1]
                  AS last_sender_name
           FROM conversation_members mine
           JOIN messages message ON message.conversation_id = mine.conversation_id
           JOIN users sender ON sender.id = message.sender_id
          WHERE mine.user_id = $1
            AND message.sender_id <> $1
            AND message.recalled_at IS NULL
            AND message.created_at > mine.last_read_at
          GROUP BY mine.conversation_id
          ORDER BY latest_unread_at DESC`,
        [user.id],
      ),
    ]);

    const onlineMembers = members.rows
      .filter((member) => realtime.isOnline(member.id))
      .map((member) => ({
        id: member.id,
        username: member.username,
        displayName: member.display_name,
        avatarColor: member.avatar_color,
        avatarUrl: publicAvatarUrl(member.id, member.avatar_object_key, member.avatar_version),
        status: activeUserStatus(member.status_text, member.status_emoji, member.status_expires_at),
      }));

    response.json({
      generatedAt: new Date().toISOString(),
      dayStartedAt: start.toISOString(),
      totalMemberCount: members.rows.length,
      onlineMembers,
      todayMessageCount: activeConversations.rows.reduce(
        (total, conversation) => total + Number(conversation.message_count),
        0,
      ),
      activeConversations: activeConversations.rows.map((conversation) => ({
        conversationId: conversation.conversation_id,
        messageCount: Number(conversation.message_count),
        lastActivityAt: conversation.last_activity_at.toISOString(),
        lastMessage: {
          type: conversation.last_message_type,
          text: conversation.last_message_text,
          senderName: conversation.last_sender_name,
        },
      })),
      unreadConversations: unreadConversations.rows.map((conversation) => ({
        conversationId: conversation.conversation_id,
        unreadCount: Number(conversation.unread_count),
        latestUnreadAt: conversation.latest_unread_at.toISOString(),
        lastMessage: {
          type: conversation.last_message_type,
          text: conversation.last_message_text,
          senderName: conversation.last_sender_name,
        },
      })),
    });
  });

  return router;
}
