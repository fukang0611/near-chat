import type {
  AgentToolContext,
  AssistantContextSource,
  AssistantContextSourceType,
} from "@near-chat/contracts";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query } from "../database.js";

const TOOL_RESULT_LIMIT = 8;
const SOURCE_EXCERPT_LIMIT = 420;

interface ChatContextRow {
  id: string;
  conversation_id: string;
  conversation_title: string;
  sender_name: string;
  content: string;
  created_at: Date;
}

interface MemoryContextRow {
  id: string;
  tier: "SHORT_TERM" | "LONG_TERM";
  title: string;
  content: string;
  conversation_id: string | null;
  target_message_id: string | null;
  updated_at: Date;
}

type SourceDraft = Omit<AssistantContextSource, "citation">;

export function escapeAssistantSearchPattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function compactAssistantSourceExcerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > SOURCE_EXCERPT_LIMIT
    ? `${compact.slice(0, SOURCE_EXCERPT_LIMIT - 1)}…`
    : compact;
}

/**
 * 公开会话回复绝不挂载跨会话和私人记忆工具。这个判断独立于界面开关，
 * 后续聊天 Mention 复用同一工具工厂时也无法误带出私人资料。
 */
export function contextToolAvailability(context: AgentToolContext) {
  const privatePreview = context.visibility === "PRIVATE_PREVIEW";
  return {
    chat: privatePreview && context.allowedConversationIds.length > 0,
    memory: privatePreview && context.allowPrivateMemory,
  };
}

export class AssistantContextCollector {
  readonly #sources = new Map<string, AssistantContextSource>();
  #chatCount = 0;
  #memoryCount = 0;

  add(source: SourceDraft): AssistantContextSource {
    const key = `${source.type}:${source.id}`;
    const existing = this.#sources.get(key);
    if (existing) return existing;

    const sequence = source.type === "MESSAGE" ? (this.#chatCount += 1) : (this.#memoryCount += 1);
    const citation = `${source.type === "MESSAGE" ? "聊天" : "记忆"}${sequence}`;
    const collected = { ...source, citation };
    this.#sources.set(key, collected);
    return collected;
  }

  values(): AssistantContextSource[] {
    return [...this.#sources.values()];
  }
}

async function searchChatMessages(
  context: AgentToolContext,
  collector: AssistantContextCollector,
  keyword: string,
  limit: number,
) {
  if (!contextToolAvailability(context).chat) return [];
  const pattern = `%${escapeAssistantSearchPattern(keyword)}%`;
  const result = await query<ChatContextRow>(
    `SELECT message.id,
            message.conversation_id,
            CASE
              WHEN conversation.type = 'GROUP' THEN COALESCE(conversation.name, '未命名群聊')
              ELSE COALESCE(
                (SELECT peer.display_name
                   FROM conversation_members peer_member
                   JOIN users peer ON peer.id = peer_member.user_id
                  WHERE peer_member.conversation_id = conversation.id
                    AND peer_member.user_id <> $1
                  ORDER BY peer_member.joined_at, peer_member.user_id
                  LIMIT 1),
                '单聊'
              )
            END AS conversation_title,
            COALESCE(message.actor_name, sender.display_name) AS sender_name,
            COALESCE(
              NULLIF(message.text_content, ''),
              (SELECT string_agg(attachment_name.original_name, '、')
                 FROM (
                   SELECT attachment.original_name
                     FROM attachments attachment
                    WHERE attachment.message_id = message.id
                   UNION
                   SELECT attachment.original_name
                     FROM message_attachment_links link
                     JOIN attachments attachment ON attachment.id = link.attachment_id
                    WHERE link.message_id = message.id
                 ) attachment_name),
              '[无文本内容]'
            ) AS content,
            message.created_at
       FROM messages message
       JOIN conversations conversation ON conversation.id = message.conversation_id
       JOIN users sender ON sender.id = message.sender_id
      WHERE message.conversation_id = ANY($2::uuid[])
        AND message.recalled_at IS NULL
        AND (
          message.text_content ILIKE $3 ESCAPE '\\'
          OR EXISTS (
            SELECT 1
              FROM (
                SELECT attachment.original_name
                  FROM attachments attachment
                 WHERE attachment.message_id = message.id
                UNION
                SELECT attachment.original_name
                  FROM message_attachment_links link
                  JOIN attachments attachment ON attachment.id = link.attachment_id
                 WHERE link.message_id = message.id
              ) attachment_name
             WHERE attachment_name.original_name ILIKE $3 ESCAPE '\\'
          )
        )
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT $4`,
    [
      context.requesterUserId,
      context.allowedConversationIds,
      pattern,
      Math.min(Math.max(limit, 1), TOOL_RESULT_LIMIT),
    ],
  );

  return result.rows.map((row) =>
    collector.add({
      type: "MESSAGE",
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.id,
      label: `${row.conversation_title} · ${row.sender_name}`,
      excerpt: compactAssistantSourceExcerpt(row.content),
      createdAt: row.created_at.toISOString(),
    }),
  );
}

async function searchPrivateMemories(
  context: AgentToolContext,
  collector: AssistantContextCollector,
  keyword: string,
  tier: "SHORT_TERM" | "LONG_TERM" | "ALL",
  limit: number,
) {
  if (!contextToolAvailability(context).memory) return [];
  const pattern = `%${escapeAssistantSearchPattern(keyword)}%`;
  const result = await query<MemoryContextRow>(
    `SELECT memory.id, memory.tier, memory.title, memory.content,
            source.conversation_id, source.target_message_id, memory.updated_at
       FROM memories memory
       LEFT JOIN LATERAL (
         SELECT memory_source.conversation_id,
                CASE WHEN memory_source.source_type = 'MESSAGE'
                     THEN memory_source.source_id ELSE NULL END AS target_message_id
           FROM memory_sources memory_source
          WHERE memory_source.memory_id = memory.id
          ORDER BY
            CASE WHEN memory_source.source_type = 'MESSAGE' THEN 0 ELSE 1 END,
            memory_source.source_created_at DESC,
            memory_source.id DESC
          LIMIT 1
       ) source ON TRUE
      WHERE memory.owner_id = $1
        AND memory.scope = 'PRIVATE'
        AND memory.status = 'ACTIVE'
        AND (memory.expires_at IS NULL OR memory.expires_at > NOW())
        AND ($2::text = 'ALL' OR memory.tier = $2)
        AND (
          memory.title ILIKE $3 ESCAPE '\\'
          OR memory.content ILIKE $3 ESCAPE '\\'
        )
      ORDER BY memory.importance DESC, memory.updated_at DESC, memory.id DESC
      LIMIT $4`,
    [context.requesterUserId, tier, pattern, Math.min(Math.max(limit, 1), TOOL_RESULT_LIMIT)],
  );

  return result.rows.map((row) =>
    collector.add({
      type: "MEMORY",
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.target_message_id,
      label: `${row.tier === "LONG_TERM" ? "长期记忆" : "近期记忆"} · ${row.title}`,
      excerpt: compactAssistantSourceExcerpt(row.content),
      createdAt: row.updated_at.toISOString(),
    }),
  );
}

function modelSource(source: AssistantContextSource) {
  return {
    citation: `[${source.citation}]`,
    label: source.label,
    content: source.excerpt,
  };
}

/** 通过闭包注入真实用户与会话范围，工具输入中不存在 userId 或权限参数。 */
export function createAssistantContextTools(
  context: AgentToolContext,
  collector: AssistantContextCollector,
) {
  const availability = contextToolAvailability(context);
  return {
    ...(availability.chat
      ? {
          search_chat_messages: createTool({
            id: "search_chat_messages",
            description:
              "在当前用户明确授权的 NearChat 团队会话中检索历史消息和附件名。需要查找过去的决定、讨论、负责人或原消息时使用。",
            inputSchema: z.object({
              query: z.string().trim().min(1).max(100),
              limit: z.number().int().min(1).max(TOOL_RESULT_LIMIT).default(6),
            }),
            execute: async ({ query: keyword, limit }) => ({
              results: (await searchChatMessages(context, collector, keyword, limit)).map(
                modelSource,
              ),
            }),
          }),
        }
      : {}),
    ...(availability.memory
      ? {
          search_memories: createTool({
            id: "search_memories",
            description:
              "检索当前用户明确授权的 NearChat 私人短期或长期记忆。需要回忆个人偏好、项目事实、决定和持续事项时使用。",
            inputSchema: z.object({
              query: z.string().trim().min(1).max(100),
              tier: z.enum(["SHORT_TERM", "LONG_TERM", "ALL"]).default("ALL"),
              limit: z.number().int().min(1).max(TOOL_RESULT_LIMIT).default(6),
            }),
            execute: async ({ query: keyword, tier, limit }) => ({
              results: (await searchPrivateMemories(context, collector, keyword, tier, limit)).map(
                modelSource,
              ),
            }),
          }),
        }
      : {}),
  };
}

export function assistantContextSourceKey(type: AssistantContextSourceType, id: string): string {
  return `${type}:${id}`;
}
