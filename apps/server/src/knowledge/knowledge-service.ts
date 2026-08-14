import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  generateKnowledgeAnswer,
  getAiCapabilities,
  searchKnowledgeVectors,
} from "../ai/ai-runtime.js";
import { stageDetachedAttachmentsForCleanup } from "../attachment-references.js";
import { publicAvatarUrl } from "../avatar-service.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import {
  isOcrImageDocument,
  supportsKnowledgeDocument,
  type KnowledgeExtractionDetails,
  type KnowledgeExtractionMethod,
} from "./document-extractor.js";

export type KnowledgeBaseAccessRole = "OWNER" | "EDITOR" | "VIEWER";
export type KnowledgeBaseMemberRole = Exclude<KnowledgeBaseAccessRole, "OWNER">;

interface KnowledgeBaseRow {
  id: string;
  owner_id: string;
  owner_username: string;
  owner_display_name: string;
  owner_avatar_color: string;
  owner_avatar_object_key: string | null;
  owner_avatar_version: number;
  name: string;
  description: string;
  document_count: string;
  ready_document_count: string;
  member_count: string;
  access_role: KnowledgeBaseAccessRole;
  created_at: Date;
  updated_at: Date;
}

interface KnowledgeBaseAccessRow {
  id: string;
  owner_id: string;
  access_role: KnowledgeBaseAccessRole | null;
}

interface KnowledgeBaseMemberRow {
  user_id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_object_key: string | null;
  avatar_version: number;
  role: KnowledgeBaseMemberRole;
  created_at: Date;
}

interface KnowledgeBaseCandidateRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_object_key: string | null;
  avatar_version: number;
}

interface KnowledgeDocumentRow {
  id: string;
  knowledge_base_id: string;
  attachment_id: string;
  name: string;
  content_type: string;
  size_bytes: string;
  status: "QUEUED" | "INDEXING" | "READY" | "FAILED";
  chunk_count: number;
  error_message: string | null;
  extraction_method: KnowledgeExtractionMethod | null;
  extraction_details: Omit<KnowledgeExtractionDetails, "method">;
  created_at: Date;
  updated_at: Date;
}

interface KnowledgeSourceRow {
  chunk_id: string;
  document_id: string;
  position: number;
  text_content: string;
  document_name: string;
  attachment_id: string;
  content_type: string;
  size_bytes: string;
  ordinal?: string;
  keyword_score?: number;
}

export interface KnowledgeSource {
  chunkId: string;
  score: number;
  excerpt: string;
  position: number;
  document: {
    id: string;
    name: string;
    attachment: {
      id: string;
      originalName: string;
      contentType: string;
      sizeBytes: number;
    };
  };
}

function publicKnowledgeBase(row: KnowledgeBaseRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: {
      id: row.owner_id,
      username: row.owner_username,
      displayName: row.owner_display_name,
      avatarColor: row.owner_avatar_color,
      avatarUrl: publicAvatarUrl(
        row.owner_id,
        row.owner_avatar_object_key,
        row.owner_avatar_version,
      ),
    },
    accessRole: row.access_role,
    memberCount: Number(row.member_count),
    documentCount: Number(row.document_count),
    readyDocumentCount: Number(row.ready_document_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicKnowledgeUser(row: KnowledgeBaseCandidateRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: publicAvatarUrl(row.id, row.avatar_object_key, row.avatar_version),
  };
}

function publicKnowledgeMember(row: KnowledgeBaseMemberRow) {
  return {
    user: publicKnowledgeUser({
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      avatar_color: row.avatar_color,
      avatar_object_key: row.avatar_object_key,
      avatar_version: row.avatar_version,
    }),
    role: row.role,
    addedAt: row.created_at.toISOString(),
  };
}

const accessRank: Record<KnowledgeBaseAccessRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

/** 角色判断保持为纯函数，路由、服务与测试共享同一权限语义。 */
export function knowledgeRoleAllows(
  actual: KnowledgeBaseAccessRole,
  required: KnowledgeBaseAccessRole,
): boolean {
  return accessRank[actual] >= accessRank[required];
}

async function knowledgeBaseAccess(
  userId: string,
  knowledgeBaseId: string,
  required: KnowledgeBaseAccessRole,
  client?: PoolClient,
  lock = false,
): Promise<KnowledgeBaseAccessRow> {
  const sql = `SELECT base.id, base.owner_id,
            CASE WHEN base.owner_id = $2 THEN 'OWNER' ELSE member.role END AS access_role
       FROM knowledge_bases base
       LEFT JOIN knowledge_base_members member
         ON member.knowledge_base_id = base.id AND member.user_id = $2
      WHERE base.id = $1${lock ? " FOR UPDATE OF base" : ""}`;
  const params = [knowledgeBaseId, userId];
  const result = client
    ? await client.query<KnowledgeBaseAccessRow>(sql, params)
    : await query<KnowledgeBaseAccessRow>(sql, params);
  const access = result.rows[0];
  if (!access?.access_role) throw new ApiError(404, "知识库不存在");
  if (!knowledgeRoleAllows(access.access_role, required)) {
    throw new ApiError(
      403,
      required === "OWNER" ? "只有知识库拥有者可以执行此操作" : "该知识库只有查看权限",
    );
  }
  return access;
}

const KNOWLEDGE_BASE_SELECT = `
  SELECT base.id, base.owner_id, owner.username AS owner_username,
         owner.display_name AS owner_display_name, owner.avatar_color AS owner_avatar_color,
         owner.avatar_object_key AS owner_avatar_object_key,
         owner.avatar_version AS owner_avatar_version,
         base.name, base.description,
         (SELECT COUNT(*)::text FROM knowledge_documents document
           WHERE document.knowledge_base_id = base.id) AS document_count,
         (SELECT COUNT(*)::text FROM knowledge_documents document
           WHERE document.knowledge_base_id = base.id AND document.status = 'READY')
           AS ready_document_count,
         (1 + (SELECT COUNT(*) FROM knowledge_base_members shared
                WHERE shared.knowledge_base_id = base.id))::text AS member_count,
         CASE WHEN base.owner_id = $1 THEN 'OWNER' ELSE access.role END AS access_role,
         base.created_at, base.updated_at
    FROM knowledge_bases base
    JOIN users owner ON owner.id = base.owner_id
    LEFT JOIN knowledge_base_members access
      ON access.knowledge_base_id = base.id AND access.user_id = $1`;

async function selectKnowledgeBase(
  userId: string,
  knowledgeBaseId: string,
  client?: PoolClient,
): Promise<KnowledgeBaseRow> {
  const sql = `${KNOWLEDGE_BASE_SELECT}
      WHERE base.id = $2 AND (base.owner_id = $1 OR access.user_id = $1)`;
  const params = [userId, knowledgeBaseId];
  const result = client
    ? await client.query<KnowledgeBaseRow>(sql, params)
    : await query<KnowledgeBaseRow>(sql, params);
  if (!result.rows[0]) throw new ApiError(404, "知识库不存在");
  return result.rows[0];
}

function publicKnowledgeDocument(row: KnowledgeDocumentRow) {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    attachment: {
      id: row.attachment_id,
      originalName: row.name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
    },
    status: row.status,
    chunkCount: row.chunk_count,
    errorMessage: row.error_message,
    extraction: row.extraction_method
      ? { ...row.extraction_details, method: row.extraction_method }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sourceFromRow(row: KnowledgeSourceRow, score: number): KnowledgeSource {
  return {
    chunkId: row.chunk_id,
    score: Math.max(0, Math.min(1, score)),
    excerpt: row.text_content,
    position: row.position,
    document: {
      id: row.document_id,
      name: row.document_name,
      attachment: {
        id: row.attachment_id,
        originalName: row.document_name,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
      },
    },
  };
}

async function enqueueJob(
  client: PoolClient,
  documentId: string,
  action: "INDEX" | "DELETE",
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_index_jobs (id, document_id, action)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id, action)
       WHERE status IN ('QUEUED', 'RUNNING')
     DO NOTHING`,
    [randomUUID(), documentId, action],
  );
}

/**
 * Embedding 模型、地址、密钥或维度改变后，旧向量均视为可重建的派生数据。
 * 这里一次性重排所有文档；原文件和已提取文本不会被删除。
 */
export async function queueAllKnowledgeDocumentsForReindex(): Promise<number> {
  return transaction(async (client) => {
    await client.query(
      `UPDATE knowledge_index_jobs
          SET status = 'FAILED', error_message = 'Embedding 配置已更新，任务重新排队',
              updated_at = NOW()
        WHERE action = 'INDEX' AND status IN ('QUEUED', 'RUNNING')`,
    );
    const documents = await client.query<{ id: string }>(
      `UPDATE knowledge_documents
          SET status = 'QUEUED', chunk_count = 0, error_message = NULL, updated_at = NOW()
        RETURNING id`,
    );
    for (const document of documents.rows) {
      await enqueueJob(client, document.id, "INDEX");
    }
    return documents.rowCount ?? 0;
  });
}

export async function listKnowledgeBases(userId: string) {
  const result = await query<KnowledgeBaseRow>(
    `${KNOWLEDGE_BASE_SELECT}
      WHERE base.owner_id = $1 OR access.user_id = $1
      ORDER BY base.updated_at DESC, base.created_at DESC`,
    [userId],
  );
  return result.rows.map(publicKnowledgeBase);
}

export async function createKnowledgeBase(
  userId: string,
  input: { name: string; description: string },
) {
  const id = randomUUID();
  await query(
    `INSERT INTO knowledge_bases (id, owner_id, name, description)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, input.name, input.description],
  );
  return publicKnowledgeBase(await selectKnowledgeBase(userId, id));
}

export async function updateKnowledgeBase(
  userId: string,
  knowledgeBaseId: string,
  input: { name?: string; description?: string },
) {
  await knowledgeBaseAccess(userId, knowledgeBaseId, "OWNER");
  await query(
    `UPDATE knowledge_bases base
        SET name = COALESCE($2, base.name),
            description = COALESCE($3, base.description),
            updated_at = NOW()
      WHERE base.id = $1`,
    [knowledgeBaseId, input.name ?? null, input.description ?? null],
  );
  return publicKnowledgeBase(await selectKnowledgeBase(userId, knowledgeBaseId));
}

export async function deleteKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<void> {
  await transaction(async (client) => {
    await knowledgeBaseAccess(userId, knowledgeBaseId, "OWNER", client, true);

    const documents = await client.query<{ id: string; attachment_id: string }>(
      `SELECT id, attachment_id FROM knowledge_documents WHERE knowledge_base_id = $1`,
      [knowledgeBaseId],
    );
    for (const document of documents.rows) {
      await client.query(
        `UPDATE knowledge_index_jobs
            SET status = 'FAILED', error_message = '文档已删除', updated_at = NOW()
          WHERE document_id = $1 AND action = 'INDEX' AND status = 'QUEUED'`,
        [document.id],
      );
      await enqueueJob(client, document.id, "DELETE");
    }
    await client.query(`DELETE FROM knowledge_bases WHERE id = $1`, [knowledgeBaseId]);
    await stageDetachedAttachmentsForCleanup(
      client,
      documents.rows.map((document) => document.attachment_id),
    );
  });
}

export async function getKnowledgeBaseMemberDirectory(userId: string, knowledgeBaseId: string) {
  await knowledgeBaseAccess(userId, knowledgeBaseId, "OWNER");
  const [base, members, candidates] = await Promise.all([
    selectKnowledgeBase(userId, knowledgeBaseId),
    query<KnowledgeBaseMemberRow>(
      `SELECT member.user_id, account.username, account.display_name,
              account.avatar_color, account.avatar_object_key, account.avatar_version,
              member.role, member.created_at
         FROM knowledge_base_members member
         JOIN users account ON account.id = member.user_id
        WHERE member.knowledge_base_id = $1 AND account.enabled = TRUE
        ORDER BY account.display_name, account.username`,
      [knowledgeBaseId],
    ),
    query<KnowledgeBaseCandidateRow>(
      `SELECT account.id, account.username, account.display_name,
              account.avatar_color, account.avatar_object_key, account.avatar_version
         FROM users account
        WHERE account.enabled = TRUE
          AND account.id <> $2
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_base_members member
             WHERE member.knowledge_base_id = $1 AND member.user_id = account.id
          )
        ORDER BY account.display_name, account.username`,
      [knowledgeBaseId, userId],
    ),
  ]);
  return {
    owner: publicKnowledgeBase(base).owner,
    members: members.rows.map(publicKnowledgeMember),
    candidates: candidates.rows.map(publicKnowledgeUser),
  };
}

export async function replaceKnowledgeBaseMembers(
  userId: string,
  knowledgeBaseId: string,
  members: Array<{ userId: string; role: KnowledgeBaseMemberRole }>,
) {
  await transaction(async (client) => {
    const access = await knowledgeBaseAccess(userId, knowledgeBaseId, "OWNER", client, true);
    const memberIds = members.map((member) => member.userId);
    if (memberIds.includes(access.owner_id)) {
      throw new ApiError(400, "知识库拥有者不能重复加入共享成员");
    }
    if (memberIds.length > 0) {
      const accounts = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE enabled = TRUE AND id = ANY($1::uuid[])`,
        [memberIds],
      );
      if (accounts.rows.length !== memberIds.length) {
        throw new ApiError(400, "共享成员不存在或已停用");
      }
    }

    await client.query(
      `DELETE FROM knowledge_base_members
        WHERE knowledge_base_id = $1
          AND NOT (user_id = ANY($2::uuid[]))`,
      [knowledgeBaseId, memberIds],
    );
    for (const member of members) {
      await client.query(
        `INSERT INTO knowledge_base_members
           (knowledge_base_id, user_id, role, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (knowledge_base_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, added_by = EXCLUDED.added_by, updated_at = NOW()`,
        [knowledgeBaseId, member.userId, member.role, userId],
      );
    }

    // 共享被撤销后，同时解除该成员私人助理上的知识库绑定。
    await client.query(
      `DELETE FROM ai_assistant_knowledge_bases binding
        USING ai_assistants assistant
        WHERE binding.assistant_id = assistant.id
          AND binding.knowledge_base_id = $1
          AND assistant.owner_id <> $2
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_base_members member
             WHERE member.knowledge_base_id = $1 AND member.user_id = assistant.owner_id
          )`,
      [knowledgeBaseId, access.owner_id],
    );
    await client.query(`UPDATE knowledge_bases SET updated_at = NOW() WHERE id = $1`, [
      knowledgeBaseId,
    ]);
  });
  return getKnowledgeBaseMemberDirectory(userId, knowledgeBaseId);
}

export async function listKnowledgeDocuments(userId: string, knowledgeBaseId: string) {
  await knowledgeBaseAccess(userId, knowledgeBaseId, "VIEWER");
  const result = await query<KnowledgeDocumentRow>(
    `SELECT document.id, document.knowledge_base_id, document.attachment_id,
            document.name, document.content_type, document.size_bytes::text,
            document.status, document.chunk_count, document.error_message,
            document.extraction_method, document.extraction_details,
            document.created_at, document.updated_at
       FROM knowledge_documents document
      WHERE document.knowledge_base_id = $1
      ORDER BY document.created_at DESC`,
    [knowledgeBaseId],
  );
  return result.rows.map(publicKnowledgeDocument);
}

export async function addKnowledgeDocument(
  userId: string,
  knowledgeBaseId: string,
  attachmentId: string,
) {
  return transaction(async (client) => {
    await knowledgeBaseAccess(userId, knowledgeBaseId, "EDITOR", client, true);
    const attachment = await client.query<{
      id: string;
      original_name: string;
      content_type: string;
      size_bytes: string;
      state: string;
    }>(
      `SELECT id, original_name, content_type, size_bytes::text, state
         FROM attachments
        WHERE id = $1 AND uploader_id = $2
        FOR UPDATE`,
      [attachmentId, userId],
    );
    const file = attachment.rows[0];
    if (!file || file.state !== "READY") throw new ApiError(404, "文件不存在或尚未就绪");
    if (!supportsKnowledgeDocument(file.original_name, file.content_type)) {
      throw new ApiError(400, "暂不支持此格式，请上传 PDF、DOCX、XLSX、图片或文本文件");
    }
    if (
      isOcrImageDocument(file.original_name, file.content_type) &&
      Number(file.size_bytes) > config.ai.knowledge.ocr.maxImageBytes
    ) {
      throw new ApiError(
        400,
        `OCR 图片不能超过 ${Math.floor(config.ai.knowledge.ocr.maxImageBytes / 1024 / 1024)} MB`,
      );
    }

    const id = randomUUID();
    let inserted: KnowledgeDocumentRow;
    try {
      const result = await client.query<KnowledgeDocumentRow>(
        `INSERT INTO knowledge_documents
           (id, knowledge_base_id, attachment_id, added_by, name, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, knowledge_base_id, attachment_id, name, content_type,
                   size_bytes::text, status, chunk_count, error_message,
                   extraction_method, extraction_details, created_at, updated_at`,
        [
          id,
          knowledgeBaseId,
          attachmentId,
          userId,
          file.original_name,
          file.content_type,
          file.size_bytes,
        ],
      );
      inserted = result.rows[0]!;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ApiError(409, "这个文件已经在当前知识库中");
      }
      throw error;
    }
    await enqueueJob(client, id, "INDEX");
    await client.query(`UPDATE knowledge_bases SET updated_at = NOW() WHERE id = $1`, [
      knowledgeBaseId,
    ]);
    return publicKnowledgeDocument(inserted);
  });
}

export async function reindexKnowledgeDocument(
  userId: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<void> {
  await transaction(async (client) => {
    await knowledgeBaseAccess(userId, knowledgeBaseId, "EDITOR", client, true);
    const document = await client.query<{ id: string; status: string }>(
      `SELECT document.id, document.status
         FROM knowledge_documents document
        WHERE document.id = $1 AND document.knowledge_base_id = $2
        FOR UPDATE OF document`,
      [documentId, knowledgeBaseId],
    );
    const current = document.rows[0];
    if (!current) throw new ApiError(404, "知识文档不存在");
    if (current.status !== "INDEXING") {
      await client.query(
        `UPDATE knowledge_documents
            SET status = 'QUEUED', error_message = NULL,
                extraction_method = NULL, extraction_details = '{}'::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [documentId],
      );
    }
    await enqueueJob(client, documentId, "INDEX");
  });
}

export async function deleteKnowledgeDocument(
  userId: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<void> {
  await transaction(async (client) => {
    await knowledgeBaseAccess(userId, knowledgeBaseId, "EDITOR", client, true);
    const document = await client.query<{ id: string; attachment_id: string }>(
      `SELECT document.id, document.attachment_id
         FROM knowledge_documents document
        WHERE document.id = $1 AND document.knowledge_base_id = $2
        FOR UPDATE OF document`,
      [documentId, knowledgeBaseId],
    );
    const current = document.rows[0];
    if (!current) throw new ApiError(404, "知识文档不存在");
    await client.query(
      `UPDATE knowledge_index_jobs
          SET status = 'FAILED', error_message = '文档已删除', updated_at = NOW()
        WHERE document_id = $1 AND action = 'INDEX' AND status = 'QUEUED'`,
      [documentId],
    );
    await enqueueJob(client, documentId, "DELETE");
    await client.query(`DELETE FROM knowledge_documents WHERE id = $1`, [documentId]);
    await client.query(`UPDATE knowledge_bases SET updated_at = NOW() WHERE id = $1`, [
      knowledgeBaseId,
    ]);
    await stageDetachedAttachmentsForCleanup(client, [current.attachment_id]);
  });
}

async function vectorSources(
  userId: string,
  knowledgeBaseId: string,
  text: string,
  topK: number,
): Promise<KnowledgeSource[]> {
  const matches = await searchKnowledgeVectors(knowledgeBaseId, text, Math.min(40, topK * 3));
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const ids = matches
    .map((match) => match.id)
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id));
  if (ids.length === 0) return [];
  const result = await query<KnowledgeSourceRow>(
    `SELECT chunk.id AS chunk_id, chunk.document_id, chunk.position, chunk.text_content,
            document.name AS document_name, document.attachment_id,
            document.content_type, document.size_bytes::text, wanted.ordinal::text
       FROM unnest($1::uuid[]) WITH ORDINALITY AS wanted(id, ordinal)
       JOIN knowledge_chunks chunk ON chunk.id = wanted.id
       JOIN knowledge_documents document ON document.id = chunk.document_id
       JOIN knowledge_bases base ON base.id = document.knowledge_base_id
      WHERE base.id = $2 AND document.status = 'READY'
        AND (
          base.owner_id = $3 OR EXISTS (
            SELECT 1 FROM knowledge_base_members member
             WHERE member.knowledge_base_id = base.id AND member.user_id = $3
          )
        )
      ORDER BY wanted.ordinal`,
    [ids, knowledgeBaseId, userId],
  );
  return result.rows
    .map((row) => sourceFromRow(row, matchById.get(row.chunk_id)?.score ?? 0))
    .slice(0, topK);
}

async function keywordSources(
  userId: string,
  knowledgeBaseId: string,
  text: string,
  topK: number,
): Promise<KnowledgeSource[]> {
  const result = await query<KnowledgeSourceRow>(
    `SELECT chunk.id AS chunk_id, chunk.document_id, chunk.position, chunk.text_content,
            document.name AS document_name, document.attachment_id,
            document.content_type, document.size_bytes::text,
            GREATEST(
              CASE WHEN chunk.text_content ILIKE $4 THEN 1.0 ELSE 0.0 END,
              ts_rank_cd(
                to_tsvector('simple', chunk.text_content),
                plainto_tsquery('simple', $3)
              )::double precision
            ) AS keyword_score
       FROM knowledge_chunks chunk
       JOIN knowledge_documents document ON document.id = chunk.document_id
       JOIN knowledge_bases base ON base.id = document.knowledge_base_id
      WHERE base.id = $1 AND document.status = 'READY'
        AND (
          base.owner_id = $2 OR EXISTS (
            SELECT 1 FROM knowledge_base_members member
             WHERE member.knowledge_base_id = base.id AND member.user_id = $2
          )
        )
        AND (
          chunk.text_content ILIKE $4
          OR to_tsvector('simple', chunk.text_content) @@ plainto_tsquery('simple', $3)
        )
      ORDER BY keyword_score DESC, document.created_at DESC, chunk.position
      LIMIT $5`,
    [knowledgeBaseId, userId, text, `%${text}%`, topK],
  );
  return result.rows.map((row) => sourceFromRow(row, Number(row.keyword_score ?? 0)));
}

export async function searchKnowledge(
  userId: string,
  knowledgeBaseId: string,
  text: string,
  requestedTopK = config.ai.knowledge.defaultTopK,
) {
  await knowledgeBaseAccess(userId, knowledgeBaseId, "VIEWER");
  const topK = Math.max(1, Math.min(20, requestedTopK));
  const keyword = await keywordSources(userId, knowledgeBaseId, text, topK);
  let semantic: KnowledgeSource[] = [];
  let mode: "HYBRID" | "KEYWORD" = "KEYWORD";
  if (getAiCapabilities().features.knowledgeSearch) {
    try {
      semantic = await vectorSources(userId, knowledgeBaseId, text, topK);
      mode = "HYBRID";
    } catch (error) {
      // 模型服务瞬时故障时仍返回本地关键词结果，不让知识资料完全不可查。
      console.warn("Knowledge semantic search failed; using keyword fallback:", error);
    }
  }

  const combined = new Map<string, KnowledgeSource>();
  semantic.forEach((source, index) => {
    combined.set(source.chunkId, { ...source, score: source.score * 0.75 + 0.25 / (index + 1) });
  });
  keyword.forEach((source, index) => {
    const existing = combined.get(source.chunkId);
    const keywordBoost = 0.2 / (index + 1);
    combined.set(
      source.chunkId,
      existing ? { ...existing, score: existing.score + keywordBoost } : source,
    );
  });
  const sources = [...combined.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map((source) => ({ ...source, score: Math.min(1, source.score) }));
  return { mode, sources };
}

export async function askKnowledge(
  userId: string,
  knowledgeBaseId: string,
  question: string,
  modelId?: string,
) {
  if (!getAiCapabilities().features.knowledgeAnswer) {
    throw new ApiError(503, "知识问答尚未就绪，请检查 AI 对话模型配置");
  }
  const result = await searchKnowledge(userId, knowledgeBaseId, question);
  if (result.sources.length === 0) {
    return {
      answer: "当前知识库中没有找到与问题相关的资料。",
      sources: [],
      generatedAt: new Date().toISOString(),
    };
  }
  const materials = result.sources
    .map(
      (source, index) =>
        `[${index + 1}] 文件：${source.document.name}，片段 ${source.position + 1}\n${source.excerpt}`,
    )
    .join("\n\n");
  const prompt = `请根据以下团队资料回答问题。不要使用资料外的事实。\n\n问题：${question}\n\n资料：\n${materials}`;
  const answer = await generateKnowledgeAnswer(prompt, modelId);
  return { answer, sources: result.sources, generatedAt: new Date().toISOString() };
}
