import { createHash, randomUUID } from "node:crypto";
import type {
  CreateMemoryInput,
  MemoryCandidate,
  MemoryCandidatePage,
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryScope,
  MemorySettings,
  MemorySourceReference,
  MemoryTier,
  UpdateMemoryInput,
} from "@near-chat/contracts";
import {
  deleteMemoryVector,
  getAiCapabilities,
  replaceMemoryVector,
  searchMemoryVectors,
} from "./ai/ai-runtime.js";
import { config } from "./config.js";
import { query, transaction } from "./database.js";
import { ApiError } from "./http.js";

interface MemoryRow {
  id: string;
  tier: "SHORT_TERM" | "LONG_TERM";
  scope: MemoryScope;
  conversation_id: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  revision: number;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  sources: Array<{
    type: MemorySourceReference["type"];
    id: string | null;
    conversationId: string | null;
    label: string;
    excerpt: string | null;
    createdAt: string | Date;
  }>;
  total_count?: number;
}

interface MutableMemoryRow {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  revision: number;
  status: "ACTIVE" | "ARCHIVED" | "DELETED";
}

interface MemoryCandidateRow {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  status: MemoryCandidate["status"];
  source_type: MemorySourceReference["type"];
  source_id: string | null;
  conversation_id: string | null;
  source_label: string;
  source_excerpt: string | null;
  source_created_at: Date;
  created_at: Date;
  updated_at: Date;
  normalized_key?: string | null;
  total_count?: number;
}

interface MemoryCandidateDraft {
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  source: {
    type: MemorySourceReference["type"];
    id: string | null;
    conversationId: string | null;
    label: string;
    excerpt: string | null;
    createdAt: Date;
  };
}

interface CandidateMessageRow {
  id: string;
  conversation_id: string;
  text_content: string | null;
  recalled_at: Date | null;
  created_at: Date;
  sender_name: string;
  conversation_title: string;
  attachment_names: string[];
}

const memorySelect = `
  SELECT memory.id,
         memory.tier,
         memory.scope,
         memory.conversation_id,
         memory.kind,
         memory.title,
         memory.content,
         memory.importance::int,
         memory.revision,
         memory.expires_at,
         memory.created_at,
         memory.updated_at,
         COALESCE(
           (SELECT json_agg(
              json_build_object(
                'type', source.source_type,
                'id', source.source_id,
                'conversationId', source.conversation_id,
                'label', source.label,
                'excerpt', source.excerpt,
                'createdAt', source.source_created_at
              ) ORDER BY source.source_created_at DESC, source.id DESC
            )
              FROM memory_sources source
             WHERE source.memory_id = memory.id),
           '[]'::json
         ) AS sources
    FROM memories memory
`;

const memoryCandidateSelect = `
  SELECT candidate.id,
         candidate.kind,
         candidate.title,
         candidate.content,
         candidate.importance::int,
         candidate.status,
         candidate.source_type,
         candidate.source_id,
         candidate.conversation_id,
         candidate.source_label,
         candidate.source_excerpt,
         candidate.source_created_at,
         candidate.created_at,
         candidate.updated_at,
         candidate.normalized_key
    FROM memory_candidates candidate
`;

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    tier: row.tier,
    scope: row.scope,
    conversationId: row.conversation_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    importance: row.importance,
    revision: row.revision,
    sources: row.sources.map((source) => ({
      ...source,
      createdAt: toIsoString(source.createdAt),
    })),
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    importance: row.importance,
    status: row.status,
    source: {
      type: row.source_type,
      id: row.source_id,
      conversationId: row.conversation_id,
      label: row.source_label,
      excerpt: row.source_excerpt,
      createdAt: row.source_created_at.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** ILIKE 仍按字面搜索用户输入，避免 `%` 和 `_` 意外扩大匹配范围。 */
export function escapeMemorySearchPattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, "\\$&");
}

function memoryVectorText(memory: Pick<MemoryRecord, "title" | "content">): string {
  return `${memory.title}\n${memory.content}`;
}

/** 向量写入是纯增强路径，失败时数据库中的原生记忆仍然完整可用。 */
function enqueueMemoryVector(userId: string, memory: MemoryRecord): void {
  if (!getAiCapabilities().features.knowledgeIndexing) return;
  void replaceMemoryVector({
    id: memory.id,
    ownerId: userId,
    tier: memory.tier,
    text: memoryVectorText(memory),
  }).catch((error) => console.warn("Failed to index memory vector:", error));
}

function enqueueMemoryVectorDeletion(memoryId: string): void {
  if (!getAiCapabilities().features.knowledgeIndexing) return;
  void deleteMemoryVector(memoryId).catch((error) =>
    console.warn("Failed to delete memory vector:", error),
  );
}

async function semanticMemoryIds(
  userId: string,
  tier: MemoryTier,
  keyword: string | undefined,
): Promise<{ ids: string[]; enhanced: boolean }> {
  if (!keyword || !getAiCapabilities().features.knowledgeIndexing) {
    return { ids: [], enhanced: false };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const matches = await Promise.race([
      searchMemoryVectors(userId, tier, keyword, 80),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("记忆语义检索超时")), 1_800);
      }),
    ]);
    return { ids: matches.map((match) => match.id), enhanced: true };
  } catch {
    return { ids: [], enhanced: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function activeMemoryById(userId: string, memoryId: string): Promise<MemoryRecord> {
  const result = await query<MemoryRow>(
    `${memorySelect}
      WHERE memory.id = $1
        AND memory.owner_id = $2
        AND memory.status = 'ACTIVE'`,
    [memoryId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "记忆不存在或已被遗忘");
  return toMemoryRecord(row);
}

/**
 * 私人记忆永远按当前登录用户过滤。关键词检索不依赖模型或 Embedding，确保 AI
 * 全局关闭、模型服务离线时，手动记忆仍可正常使用。
 */
export async function listMemories(
  userId: string,
  input: {
    keyword?: string;
    kind?: MemoryKind;
    tier: MemoryTier;
    limit: number;
    offset: number;
  },
): Promise<MemoryPage> {
  const pattern = input.keyword ? `%${escapeMemorySearchPattern(input.keyword)}%` : null;
  const semantic = await semanticMemoryIds(userId, input.tier, input.keyword);
  const result = await query<MemoryRow>(
    `SELECT page.*, COUNT(*) OVER()::int AS total_count
       FROM (${memorySelect}
              WHERE memory.owner_id = $1
                AND memory.status = 'ACTIVE'
                AND memory.tier = $2
                AND memory.scope = 'PRIVATE'
                AND (memory.expires_at IS NULL OR memory.expires_at > NOW())
                AND ($3::text IS NULL OR memory.kind = $3)
                AND (
                  $4::text IS NULL
                  OR memory.title ILIKE $4 ESCAPE '\\'
                  OR memory.content ILIKE $4 ESCAPE '\\'
                  OR memory.id = ANY($5::uuid[])
                )) page
      ORDER BY
        CASE
          WHEN $4::text IS NOT NULL AND (
            page.title ILIKE $4 ESCAPE '\\' OR page.content ILIKE $4 ESCAPE '\\'
          ) THEN 0
          ELSE 1
        END,
        COALESCE(array_position($5::uuid[], page.id), 2147483647),
        page.importance DESC,
        page.updated_at DESC,
        page.id DESC
      LIMIT $6 OFFSET $7`,
    [userId, input.tier, input.kind ?? null, pattern, semantic.ids, input.limit, input.offset],
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  return {
    memories: result.rows.map(toMemoryRecord),
    total,
    offset: input.offset,
    hasMore: input.offset + result.rows.length < total,
    searchMode: semantic.enhanced ? "HYBRID" : "KEYWORD",
  };
}

export async function createManualMemory(
  userId: string,
  input: CreateMemoryInput,
): Promise<MemoryRecord> {
  const memoryId = randomUUID();
  const tier = input.tier ?? "LONG_TERM";
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO memories
         (id, owner_id, tier, scope, kind, title, content, importance, expires_at)
       VALUES ($1, $2, $3, 'PRIVATE', $4, $5, $6, $7,
               CASE WHEN $3::varchar = 'SHORT_TERM' THEN NOW() + INTERVAL '7 days' ELSE NULL END)`,
      [memoryId, userId, tier, input.kind, input.title, input.content, input.importance],
    );
    await client.query(
      `INSERT INTO memory_revisions
         (id, memory_id, revision, kind, title, content, importance, change_type, changed_by)
       VALUES ($1, $2, 1, $3, $4, $5, $6, 'CREATE', $7)`,
      [randomUUID(), memoryId, input.kind, input.title, input.content, input.importance, userId],
    );
    await client.query(
      `INSERT INTO memory_sources
         (id, memory_id, source_type, label, source_created_at)
       VALUES ($1, $2, 'MANUAL', '用户手动创建', NOW())`,
      [randomUUID(), memoryId],
    );
  });
  const memory = await activeMemoryById(userId, memoryId);
  enqueueMemoryVector(userId, memory);
  return memory;
}

/**
 * 只识别用户明确表达的记忆意图，不把普通聊天内容擅自写入私人记忆。
 * 返回值可直接进入候选内容；没有明确触发词时返回 null。
 */
export function extractExplicitMemoryHint(text: string | null | undefined): string | null {
  if (!text) return null;
  const matched = text.match(
    /^\s*(?:请\s*)?(?:帮我\s*)?(?:记住|记一下|记下来|记录一下)[：:,，\s]+([\s\S]+?)\s*$/u,
  );
  const content = matched?.[1]?.trim();
  return content ? content.slice(0, 10_000) : null;
}

/** 候选标题保持一行且可扫描；详细原文完整保留在 content 中。 */
export function memoryCandidateTitle(content: string, fallback = "来自聊天的记忆"): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 54 ? `${normalized.slice(0, 53)}…` : normalized;
}

/**
 * 候选指纹只用于当前账号内的去重，不作为展示文本。NFKC 与标点折叠可以吸收
 * 全半角、空白和常见排版差异，哈希后不会把聊天内容复制进索引字段。
 */
export function normalizeMemoryCandidateContent(content: string): string {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "")
    .trim();
}

export function memoryCandidateNormalizedKey(kind: MemoryKind, content: string): string {
  const normalized = normalizeMemoryCandidateContent(content);
  return createHash("sha256").update(`${kind}\n${normalized}`).digest("hex");
}

/** 中文候选使用二元字符 Dice 系数，吸收模型轻微改写但避免合并不同事实。 */
export function memoryCandidateSimilarity(left: string, right: string): number {
  const a = normalizeMemoryCandidateContent(left);
  const b = normalizeMemoryCandidateContent(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 4) return 0;
  if (a.includes(b) || b.includes(a))
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);

  const counts = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

export async function getMemorySettings(userId: string): Promise<MemorySettings> {
  const result = await query<{
    explicit_capture_enabled: boolean;
    semantic_capture_enabled: boolean;
    updated_at: Date;
  }>(
    `SELECT explicit_capture_enabled, semantic_capture_enabled, updated_at
       FROM memory_settings
      WHERE owner_id = $1`,
    [userId],
  );
  const settings = result.rows[0];
  return {
    explicitCaptureEnabled: settings?.explicit_capture_enabled ?? true,
    semanticCaptureEnabled: settings?.semantic_capture_enabled ?? false,
    semanticCaptureMessageThreshold: config.ai.memory.messageThreshold,
    semanticCaptureSilenceMinutes: config.ai.memory.silenceMinutes,
    shortTermRetentionDays: 7,
    updatedAt: settings?.updated_at.toISOString() ?? null,
  };
}

export async function updateMemorySettings(
  userId: string,
  input: { explicitCaptureEnabled?: boolean; semanticCaptureEnabled?: boolean },
): Promise<MemorySettings> {
  await transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `memory-candidate:${userId}`,
    ]);
    await client.query(
      `INSERT INTO memory_settings
         (owner_id, explicit_capture_enabled, semantic_capture_enabled)
       VALUES ($1, COALESCE($2::boolean, TRUE), COALESCE($3::boolean, FALSE))
       ON CONFLICT (owner_id) DO UPDATE
         SET explicit_capture_enabled = COALESCE($2::boolean, memory_settings.explicit_capture_enabled),
             semantic_capture_enabled = COALESCE($3::boolean, memory_settings.semantic_capture_enabled),
             updated_at = NOW()`,
      [userId, input.explicitCaptureEnabled ?? null, input.semanticCaptureEnabled ?? null],
    );
    if (input.semanticCaptureEnabled === false) {
      // 待处理批次是可重建派生数据；关闭后立即清空，运行中的任务在落库前还会复核开关。
      await client.query(`DELETE FROM memory_capture_states WHERE owner_id = $1`, [userId]);
      await client.query(
        `DELETE FROM memory_capture_jobs
          WHERE owner_id = $1 AND status IN ('QUEUED', 'FAILED')`,
        [userId],
      );
    }
  });
  return getMemorySettings(userId);
}

async function messageForMemoryCandidate(
  userId: string,
  messageId: string,
): Promise<CandidateMessageRow> {
  const result = await query<CandidateMessageRow>(
    `SELECT message.id,
            message.conversation_id,
            message.text_content,
            message.recalled_at,
            message.created_at,
            sender.display_name AS sender_name,
            COALESCE(conversation.name, '私聊') AS conversation_title,
            COALESCE(
              array_agg(DISTINCT attachment.original_name)
                FILTER (WHERE attachment.id IS NOT NULL),
              ARRAY[]::text[]
            ) AS attachment_names
       FROM messages message
       JOIN users sender ON sender.id = message.sender_id
       JOIN conversations conversation ON conversation.id = message.conversation_id
       JOIN conversation_members member
         ON member.conversation_id = message.conversation_id AND member.user_id = $2
       LEFT JOIN LATERAL (
         SELECT owned.id, owned.original_name
           FROM attachments owned
          WHERE owned.message_id = message.id
         UNION
         SELECT linked.id, linked.original_name
           FROM message_attachment_links message_link
           JOIN attachments linked ON linked.id = message_link.attachment_id
          WHERE message_link.message_id = message.id
       ) attachment ON TRUE
      WHERE message.id = $1
      GROUP BY message.id, sender.display_name, conversation.name`,
    [messageId, userId],
  );
  const message = result.rows[0];
  if (!message) throw new ApiError(404, "消息不存在或你已不在该会话中");
  if (message.recalled_at) throw new ApiError(409, "已撤回的消息不能加入记忆");
  return message;
}

async function candidateById(userId: string, candidateId: string): Promise<MemoryCandidate> {
  const result = await query<MemoryCandidateRow>(
    `${memoryCandidateSelect}
      WHERE candidate.id = $1 AND candidate.owner_id = $2`,
    [candidateId, userId],
  );
  const candidate = result.rows[0];
  if (!candidate) throw new ApiError(404, "记忆候选不存在");
  return toMemoryCandidate(candidate);
}

/**
 * 同一账号的候选写入使用事务级锁串行化：精确指纹由数据库唯一索引兜底，模型
 * 轻微改写则通过高阈值相似度合并。这里只合并待确认项，不触碰已接受的记忆。
 */
async function upsertMemoryCandidate(
  userId: string,
  draft: MemoryCandidateDraft,
  semanticConversationId?: string,
): Promise<{ candidate: MemoryCandidate; created: boolean }> {
  const normalizedKey = memoryCandidateNormalizedKey(draft.kind, draft.content);
  const result = await transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `memory-candidate:${userId}`,
    ]);
    if (semanticConversationId) {
      const allowed = await client.query(
        `SELECT 1
           FROM memory_settings settings
           JOIN conversation_members member ON member.user_id = settings.owner_id
          WHERE settings.owner_id = $1
            AND settings.semantic_capture_enabled = TRUE
            AND member.conversation_id = $2`,
        [userId, semanticConversationId],
      );
      if (!allowed.rowCount) throw new ApiError(409, "会话智能整理已关闭");
    }
    const pending = await client.query<MemoryCandidateRow>(
      `${memoryCandidateSelect}
        WHERE candidate.owner_id = $1 AND candidate.status = 'PENDING'
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 100
        FOR UPDATE`,
      [userId],
    );
    const sameSource = pending.rows.find(
      (candidate) =>
        draft.source.id &&
        candidate.source_type === draft.source.type &&
        candidate.source_id === draft.source.id,
    );
    const similar = pending.rows.find(
      (candidate) =>
        candidate.kind === draft.kind &&
        (candidate.normalized_key === normalizedKey ||
          memoryCandidateSimilarity(candidate.content, draft.content) >= 0.86),
    );
    const existing = sameSource ?? similar;
    if (existing) {
      await client.query(
        `UPDATE memory_candidates
            SET title = CASE WHEN length($2) > length(title) THEN $2 ELSE title END,
                content = CASE WHEN length($3) > length(content) THEN $3 ELSE content END,
                importance = GREATEST(importance, $4),
                source_type = CASE WHEN source_created_at <= $10 THEN $5 ELSE source_type END,
                source_id = CASE WHEN source_created_at <= $10 THEN $6 ELSE source_id END,
                conversation_id = CASE WHEN source_created_at <= $10 THEN $7 ELSE conversation_id END,
                source_label = CASE WHEN source_created_at <= $10 THEN $8 ELSE source_label END,
                source_excerpt = CASE WHEN source_created_at <= $10 THEN $9 ELSE source_excerpt END,
                source_created_at = GREATEST(source_created_at, $10),
                updated_at = NOW()
          WHERE id = $1`,
        [
          existing.id,
          draft.title,
          draft.content,
          draft.importance,
          draft.source.type,
          draft.source.id,
          draft.source.conversationId,
          draft.source.label,
          draft.source.excerpt,
          draft.source.createdAt,
        ],
      );
      return { id: existing.id, created: false };
    }

    const candidateId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memory_candidates
         (id, owner_id, source_type, source_id, conversation_id, source_label,
          source_excerpt, source_created_at, kind, title, content, importance, normalized_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        candidateId,
        userId,
        draft.source.type,
        draft.source.id,
        draft.source.conversationId,
        draft.source.label,
        draft.source.excerpt,
        draft.source.createdAt,
        draft.kind,
        draft.title,
        draft.content,
        draft.importance,
        normalizedKey,
      ],
    );
    if (inserted.rows[0]) return { id: candidateId, created: true };

    const conflicted = await client.query<{ id: string }>(
      `SELECT id
         FROM memory_candidates
        WHERE owner_id = $1 AND status = 'PENDING'
          AND (
            normalized_key = $2
            OR ($3::uuid IS NOT NULL AND source_type = $4 AND source_id = $3)
          )
        ORDER BY updated_at DESC
        LIMIT 1`,
      [userId, normalizedKey, draft.source.id, draft.source.type],
    );
    const conflictedId = conflicted.rows[0]?.id;
    if (!conflictedId) throw new ApiError(409, "记忆候选状态刚刚发生变化，请重试");
    return { id: conflictedId, created: false };
  });
  return { candidate: await candidateById(userId, result.id), created: result.created };
}

/**
 * 将当前用户有权读取的消息快照成候选。重复点击同一条消息会返回原有待确认项，
 * 不会在列表中制造重复内容。
 */
export async function createMessageMemoryCandidate(
  userId: string,
  messageId: string,
  contentOverride?: string,
): Promise<{ candidate: MemoryCandidate; created: boolean }> {
  const message = await messageForMemoryCandidate(userId, messageId);
  const attachmentText = message.attachment_names.length
    ? `附件：${message.attachment_names.join("、")}`
    : "";
  const content =
    contentOverride?.trim() ||
    [message.text_content?.trim(), attachmentText].filter(Boolean).join("\n") ||
    "一条聊天消息";
  return upsertMemoryCandidate(userId, {
    kind: "NOTE",
    title: memoryCandidateTitle(content, `${message.sender_name} 分享的内容`),
    content,
    importance: 3,
    source: {
      type: "MESSAGE",
      id: message.id,
      conversationId: message.conversation_id,
      label: `${message.conversation_title} · ${message.sender_name}`,
      excerpt:
        [message.text_content?.trim(), attachmentText].filter(Boolean).join("\n").slice(0, 1000) ||
        null,
      createdAt: message.created_at,
    },
  });
}

/** 语义整理也只写入待确认候选，用户接受前不会形成真实记忆。 */
export function createGeneratedMemoryCandidate(
  userId: string,
  input: {
    kind: MemoryKind;
    title: string;
    content: string;
    importance: number;
    sourceMessageId: string;
    conversationId: string;
    sourceLabel: string;
    sourceExcerpt: string;
    sourceCreatedAt: Date;
  },
): Promise<{ candidate: MemoryCandidate; created: boolean }> {
  return upsertMemoryCandidate(
    userId,
    {
      kind: input.kind,
      title: input.title,
      content: input.content,
      importance: input.importance,
      source: {
        type: "MESSAGE",
        id: input.sourceMessageId,
        conversationId: input.conversationId,
        label: input.sourceLabel,
        excerpt: input.sourceExcerpt,
        createdAt: input.sourceCreatedAt,
      },
    },
    input.conversationId,
  );
}

/** 消息发送完成后的轻量识别；调用方应以 fire-and-forget 方式执行。 */
export async function captureExplicitMessageMemory(
  userId: string,
  messageId: string,
  text: string | null | undefined,
): Promise<boolean> {
  const hint = extractExplicitMemoryHint(text);
  if (!hint) return false;
  const settings = await getMemorySettings(userId);
  if (!settings.explicitCaptureEnabled) return false;
  await createMessageMemoryCandidate(userId, messageId, hint);
  return true;
}

export async function listMemoryCandidates(userId: string): Promise<MemoryCandidatePage> {
  const result = await query<MemoryCandidateRow>(
    `SELECT page.*, COUNT(*) OVER()::int AS total_count
       FROM (${memoryCandidateSelect}
              WHERE candidate.owner_id = $1 AND candidate.status = 'PENDING') page
      ORDER BY page.created_at DESC, page.id DESC`,
    [userId],
  );
  return {
    candidates: result.rows.map(toMemoryCandidate),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export async function acceptMemoryCandidate(
  userId: string,
  candidateId: string,
  tier: MemoryTier,
): Promise<MemoryRecord> {
  const memoryId = randomUUID();
  await transaction(async (client) => {
    const result = await client.query<MemoryCandidateRow>(
      `${memoryCandidateSelect}
        WHERE candidate.id = $1 AND candidate.owner_id = $2
        FOR UPDATE`,
      [candidateId, userId],
    );
    const candidate = result.rows[0];
    if (!candidate) throw new ApiError(404, "记忆候选不存在");
    if (candidate.status !== "PENDING") throw new ApiError(409, "这条候选已经处理");

    await client.query(
      `INSERT INTO memories
         (id, owner_id, tier, scope, kind, title, content, importance, expires_at)
       VALUES ($1, $2, $3, 'PRIVATE', $4, $5, $6, $7,
               CASE WHEN $3::varchar = 'SHORT_TERM' THEN NOW() + INTERVAL '7 days' ELSE NULL END)`,
      [
        memoryId,
        userId,
        tier,
        candidate.kind,
        candidate.title,
        candidate.content,
        candidate.importance,
      ],
    );
    await client.query(
      `INSERT INTO memory_revisions
         (id, memory_id, revision, kind, title, content, importance, change_type, changed_by)
       VALUES ($1, $2, 1, $3, $4, $5, $6, 'CREATE', $7)`,
      [
        randomUUID(),
        memoryId,
        candidate.kind,
        candidate.title,
        candidate.content,
        candidate.importance,
        userId,
      ],
    );
    await client.query(
      `INSERT INTO memory_sources
         (id, memory_id, source_type, source_id, conversation_id, label, excerpt,
          source_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        memoryId,
        candidate.source_type,
        candidate.source_id,
        candidate.conversation_id,
        candidate.source_label,
        candidate.source_excerpt,
        candidate.source_created_at,
      ],
    );
    await client.query(
      `UPDATE memory_candidates
          SET status = 'ACCEPTED', resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [candidateId],
    );
  });
  const memory = await activeMemoryById(userId, memoryId);
  enqueueMemoryVector(userId, memory);
  return memory;
}

export async function rejectMemoryCandidate(userId: string, candidateId: string): Promise<void> {
  const result = await query(
    `UPDATE memory_candidates
        SET status = 'REJECTED', resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND owner_id = $2 AND status = 'PENDING'`,
    [candidateId, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "记忆候选不存在或已经处理");
}

/** Embedding 配置或维度变化后后台补齐现有记忆，不阻塞服务开放端口。 */
export async function queueAllMemoryVectorsForReindex(): Promise<number> {
  if (!getAiCapabilities().features.knowledgeIndexing) return 0;
  const result = await query<{
    id: string;
    owner_id: string;
    tier: MemoryTier;
    title: string;
    content: string;
  }>(
    `SELECT id, owner_id, tier, title, content
       FROM memories
      WHERE status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY updated_at DESC, id DESC`,
  );
  for (const memory of result.rows) {
    void replaceMemoryVector({
      id: memory.id,
      ownerId: memory.owner_id,
      tier: memory.tier,
      text: `${memory.title}\n${memory.content}`,
    }).catch((error) => console.warn("Failed to reindex memory vector:", error));
  }
  return result.rows.length;
}

export async function updateMemory(
  userId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): Promise<MemoryRecord> {
  await transaction(async (client) => {
    const existing = await client.query<MutableMemoryRow>(
      `SELECT id, kind, title, content, importance::int, revision, status
         FROM memories
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [memoryId, userId],
    );
    const memory = existing.rows[0];
    if (!memory || memory.status !== "ACTIVE") {
      throw new ApiError(404, "记忆不存在或已被遗忘");
    }
    if (memory.revision !== input.baseRevision) {
      throw new ApiError(409, "这条记忆已在其他窗口更新，请刷新后再保存");
    }

    const next = {
      kind: input.kind ?? memory.kind,
      title: input.title ?? memory.title,
      content: input.content ?? memory.content,
      importance: input.importance ?? memory.importance,
      revision: memory.revision + 1,
    };
    await client.query(
      `UPDATE memories
          SET kind = $3,
              title = $4,
              content = $5,
              importance = $6,
              revision = $7,
              updated_at = NOW()
        WHERE id = $1 AND owner_id = $2`,
      [memoryId, userId, next.kind, next.title, next.content, next.importance, next.revision],
    );
    await client.query(
      `INSERT INTO memory_revisions
         (id, memory_id, revision, kind, title, content, importance, change_type, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CORRECT', $8)`,
      [
        randomUUID(),
        memoryId,
        next.revision,
        next.kind,
        next.title,
        next.content,
        next.importance,
        userId,
      ],
    );
  });
  const memory = await activeMemoryById(userId, memoryId);
  enqueueMemoryVector(userId, memory);
  return memory;
}

/** 采用软删除并追加 FORGET 修订，后续可实现合规审计和跨终端同步。 */
export async function forgetMemory(userId: string, memoryId: string): Promise<void> {
  await transaction(async (client) => {
    const existing = await client.query<MutableMemoryRow>(
      `SELECT id, kind, title, content, importance::int, revision, status
         FROM memories
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [memoryId, userId],
    );
    const memory = existing.rows[0];
    if (!memory || memory.status !== "ACTIVE") {
      throw new ApiError(404, "记忆不存在或已被遗忘");
    }
    const nextRevision = memory.revision + 1;
    await client.query(
      `UPDATE memories
          SET status = 'DELETED',
              revision = $3,
              updated_at = NOW(),
              deleted_at = NOW()
        WHERE id = $1 AND owner_id = $2`,
      [memoryId, userId, nextRevision],
    );
    await client.query(
      `INSERT INTO memory_revisions
         (id, memory_id, revision, kind, title, content, importance, change_type, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'FORGET', $8)`,
      [
        randomUUID(),
        memoryId,
        nextRevision,
        memory.kind,
        memory.title,
        memory.content,
        memory.importance,
        userId,
      ],
    );
  });
  enqueueMemoryVectorDeletion(memoryId);
}

/**
 * 短期记忆到期后转为归档状态；正文与修订仍保留，向量作为派生数据异步删除。
 * 此任务完全不依赖模型，即使 AI 关闭也会持续执行。
 */
export async function archiveExpiredShortTermMemories(): Promise<number> {
  const archived = await query<{ id: string }>(
    `UPDATE memories
        SET status = 'ARCHIVED', updated_at = NOW()
      WHERE tier = 'SHORT_TERM'
        AND status = 'ACTIVE'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      RETURNING id`,
  );
  for (const memory of archived.rows) enqueueMemoryVectorDeletion(memory.id);
  return archived.rows.length;
}
