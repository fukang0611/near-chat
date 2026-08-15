import { randomUUID } from "node:crypto";
import type {
  CreateMemoryInput,
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryScope,
  MemorySourceReference,
  UpdateMemoryInput,
} from "@near-chat/contracts";
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

/** ILIKE 仍按字面搜索用户输入，避免 `%` 和 `_` 意外扩大匹配范围。 */
export function escapeMemorySearchPattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, "\\$&");
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
    limit: number;
    offset: number;
  },
): Promise<MemoryPage> {
  const pattern = input.keyword ? `%${escapeMemorySearchPattern(input.keyword)}%` : null;
  const result = await query<MemoryRow>(
    `SELECT page.*, COUNT(*) OVER()::int AS total_count
       FROM (${memorySelect}
              WHERE memory.owner_id = $1
                AND memory.status = 'ACTIVE'
                AND memory.tier = 'LONG_TERM'
                AND memory.scope = 'PRIVATE'
                AND ($2::text IS NULL OR memory.kind = $2)
                AND (
                  $3::text IS NULL
                  OR memory.title ILIKE $3 ESCAPE '\\'
                  OR memory.content ILIKE $3 ESCAPE '\\'
                )) page
      ORDER BY page.importance DESC, page.updated_at DESC, page.id DESC
      LIMIT $4 OFFSET $5`,
    [userId, input.kind ?? null, pattern, input.limit, input.offset],
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  return {
    memories: result.rows.map(toMemoryRecord),
    total,
    offset: input.offset,
    hasMore: input.offset + result.rows.length < total,
  };
}

export async function createManualMemory(
  userId: string,
  input: CreateMemoryInput,
): Promise<MemoryRecord> {
  const memoryId = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO memories
         (id, owner_id, tier, scope, kind, title, content, importance)
       VALUES ($1, $2, 'LONG_TERM', 'PRIVATE', $3, $4, $5, $6)`,
      [memoryId, userId, input.kind, input.title, input.content, input.importance],
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
  return activeMemoryById(userId, memoryId);
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
  return activeMemoryById(userId, memoryId);
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
}
