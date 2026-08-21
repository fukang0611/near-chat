import { isDeepStrictEqual } from "node:util";
import type {
  PersonalEntityType,
  SyncChange,
  SyncEntityType,
  SyncOperation,
} from "@near-chat/domain";
import type { PoolClient } from "pg";
import { z } from "zod";
import { stageDetachedAttachmentsForCleanup } from "./attachment-references.js";
import { ApiError } from "./http.js";
import {
  applyPersonalSyncOperation,
  loadPersonalSyncState,
  parsePersonalSyncPayload,
  type PersonalRecordSyncPayload,
  type PersonalReminderSyncPayload,
  type PersonalTaskSyncPayload,
} from "./personal-service.js";
import { loadSyncSnapshot, recordSyncSnapshot } from "./sync-projection.js";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const memoryPayload = z.object({
  tier: z.enum(["SHORT_TERM", "LONG_TERM"]),
  // 移动端首版只漫游私人记忆；会话记忆仍受团队成员关系约束，不进入离线副本。
  scope: z.literal("PRIVATE"),
  conversationId: z.null(),
  kind: z.enum([
    "PREFERENCE",
    "PERSON",
    "PROJECT",
    "DECISION",
    "PROCEDURE",
    "GOAL",
    "NOTE",
    "TASK_CONTEXT",
  ]),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(10_000),
  importance: z.number().int().min(1).max(5),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  expiresAt: nullableTimestamp,
});
const assistantPayload = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(240),
    category: z.enum(["GENERAL", "WRITING", "ANALYSIS", "PLANNING"]),
    instructions: z.string().trim().min(1).max(6000),
    avatarColor: z.string().regex(/^#[0-9A-F]{6}$/i, "头像颜色格式不正确"),
    modelId: uuid.nullable(),
  })
  // toolGrants 是 SERVER_MANAGED 字段：下行快照携带，客户端回推时在此丢弃。
  .strip();
const assistantThreadPayload = z.object({
  assistantId: uuid,
  title: z.string().trim().min(1).max(80),
  archived: z.boolean(),
  isDefault: z.boolean(),
});
const localMemorySource = z
  .object({
    type: z.literal("MEMORY"),
    id: uuid,
    title: z.string().trim().min(1).max(120),
  })
  .strip();
const knowledgeSource = z
  .object({
    chunkId: uuid,
    score: z.number().finite(),
    excerpt: z.string().max(4_000),
    position: z.number().int().nonnegative(),
    document: z
      .object({
        id: uuid,
        name: z.string().max(255),
        attachment: z
          .object({
            id: uuid,
            originalName: z.string().max(255),
            contentType: z.string().max(255),
            sizeBytes: z.number().int().nonnegative(),
          })
          .strip(),
      })
      .strip(),
  })
  .strip();
const assistantMessageFields = {
  assistantId: uuid,
  threadId: uuid,
  role: z.enum(["USER", "ASSISTANT"]),
  content: z.string().trim().min(1).max(50_000),
  modelId: uuid.nullable(),
  // 明确限制结构与正文长度，使单个合法 operation 有稳定上界，可安全按 HTTP 字节预算分批。
  sources: z
    .array(z.union([localMemorySource, knowledgeSource]))
    .max(50)
    .default([]),
};

export const ASSISTANT_MESSAGE_SYNC_PAYLOAD_MAX_BYTES = 640 * 1024;

function assistantMessagePayloadBytesWithinLimit(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  // 字符数无法覆盖 UTF-8 与 JSON 转义膨胀；最终序列化仍必须给 768KiB 响应预算留余量。
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") > ASSISTANT_MESSAGE_SYNC_PAYLOAD_MAX_BYTES
  ) {
    context.addIssue({ code: "custom", message: "助理消息同步数据过大" });
  }
}

const assistantMessagePayload = z
  .object(assistantMessageFields)
  .superRefine(assistantMessagePayloadBytesWithinLimit);
const authoritativeAssistantMessagePayload = z
  .object({
    id: uuid,
    ...assistantMessageFields,
    revision: z.number().int().positive(),
    createdAt: timestamp,
  })
  .superRefine(assistantMessagePayloadBytesWithinLimit);

export type MemorySyncPayload = z.infer<typeof memoryPayload>;
export type AssistantSyncPayload = z.infer<typeof assistantPayload>;
export type AssistantThreadSyncPayload = z.infer<typeof assistantThreadPayload>;
export type AssistantMessageSyncPayload = z.infer<typeof assistantMessagePayload>;
export type AuthoritativeAssistantMessageSyncPayload = z.infer<
  typeof authoritativeAssistantMessagePayload
>;
export type ParsedSyncEntityPayload =
  | PersonalTaskSyncPayload
  | PersonalReminderSyncPayload
  | PersonalRecordSyncPayload
  | MemorySyncPayload
  | AssistantSyncPayload
  | AssistantThreadSyncPayload
  | AssistantMessageSyncPayload;

/** 同步入口只接受明确业务字段，所有 ID、owner、revision 和服务端时间均由服务端决定。 */
export function parseSyncEntityPayload(
  entityType: SyncEntityType,
  payload: Record<string, unknown>,
): ParsedSyncEntityPayload {
  switch (entityType) {
    case "PERSONAL_TASK":
      return parsePersonalSyncPayload("PERSONAL_TASK", payload);
    case "PERSONAL_REMINDER":
      return parsePersonalSyncPayload("PERSONAL_REMINDER", payload);
    case "PERSONAL_RECORD":
      return parsePersonalSyncPayload("PERSONAL_RECORD", payload);
    case "MEMORY":
      return memoryPayload.parse(payload);
    case "ASSISTANT":
      return assistantPayload.parse(payload);
    case "ASSISTANT_THREAD":
      return assistantThreadPayload.parse(payload);
    case "ASSISTANT_MESSAGE":
      return assistantMessagePayload.parse(payload);
  }
}

/**
 * 普通 REST/模型回复和同步投影共用同一份下行结构、字符与 UTF-8 字节门禁。
 * 写入前使用 400；读取遗留非法行时使用 413，便于明确定位阻塞同步的实体。
 */
export function authoritativeAssistantMessageSyncPayload(
  payload: Record<string, unknown>,
  status = 400,
): AuthoritativeAssistantMessageSyncPayload {
  const parsed = authoritativeAssistantMessagePayload.safeParse(payload);
  if (!parsed.success) {
    const entity = typeof payload.id === "string" ? ` ${payload.id}` : "";
    throw new ApiError(
      status,
      `助理消息${entity}无法跨端同步：${parsed.error.issues[0]?.message ?? "结构或大小不符合限制"}`,
    );
  }
  return parsed.data;
}

export interface AuthoritativeSyncState {
  revision: number;
  deleted: boolean;
  completedAt?: string | null;
  payload: Record<string, unknown>;
  updatedAt: string;
  lastChange?: SyncChange | null;
}

interface MemoryRow {
  id: string;
  tier: "SHORT_TERM" | "LONG_TERM";
  scope: "PRIVATE" | "CONVERSATION";
  conversation_id: string | null;
  kind: MemorySyncPayload["kind"];
  title: string;
  content: string;
  importance: number;
  status: "ACTIVE" | "ARCHIVED" | "DELETED";
  revision: number;
  expires_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AssistantRow {
  id: string;
  name: string;
  description: string;
  category: AssistantSyncPayload["category"];
  instructions: string;
  avatar_color: string;
  model_id: string | null;
  cross_conversation_search: boolean;
  private_memory_read: boolean;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AssistantThreadRow {
  id: string;
  assistant_id: string;
  title: string;
  archived: boolean;
  is_default: boolean;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AssistantMessageRow {
  id: string;
  assistant_id: string;
  thread_id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  model_id: string | null;
  sources: unknown[];
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
}

export function memoryState(row: MemoryRow): AuthoritativeSyncState {
  const deleted = row.status === "DELETED" || Boolean(row.deleted_at);
  return {
    revision: row.revision,
    deleted,
    // 已删除记忆只向同步域暴露定位和版本信息；正文继续保留在 memory_revisions
    // 供服务端审计，但不能复制到离线 tombstone、增量流或幂等 operation outcome。
    payload: deleted
      ? {
          id: row.id,
          revision: row.revision,
          deletedAt: (row.deleted_at ?? row.updated_at).toISOString(),
        }
      : {
          id: row.id,
          tier: row.tier,
          scope: row.scope,
          conversationId: row.conversation_id,
          kind: row.kind,
          title: row.title,
          content: row.content,
          importance: row.importance,
          status: row.status,
          revision: row.revision,
          expiresAt: row.expires_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          deletedAt: null,
        },
    updatedAt: row.updated_at.toISOString(),
  };
}

export function assistantState(row: AssistantRow): AuthoritativeSyncState {
  const deleted = Boolean(row.deleted_at);
  return {
    revision: row.revision,
    deleted,
    payload: deleted
      ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at!.toISOString() }
      : {
          id: row.id,
          name: row.name,
          description: row.description,
          category: row.category,
          instructions: row.instructions,
          avatarColor: row.avatar_color,
          modelId: row.model_id,
          toolGrants: {
            crossConversationSearch: row.cross_conversation_search,
            privateMemoryRead: row.private_memory_read,
          },
          revision: row.revision,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
    updatedAt: row.updated_at.toISOString(),
  };
}

function assistantThreadState(row: AssistantThreadRow): AuthoritativeSyncState {
  const deleted = Boolean(row.deleted_at);
  return {
    revision: row.revision,
    deleted,
    payload: deleted
      ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at!.toISOString() }
      : {
          id: row.id,
          assistantId: row.assistant_id,
          title: row.title,
          archived: row.archived,
          isDefault: row.is_default,
          revision: row.revision,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
    updatedAt: row.updated_at.toISOString(),
  };
}

export function assistantMessageState(row: AssistantMessageRow): AuthoritativeSyncState {
  const deleted = Boolean(row.deleted_at);
  const payload = deleted
    ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at!.toISOString() }
    : authoritativeAssistantMessageSyncPayload(
        {
          id: row.id,
          assistantId: row.assistant_id,
          threadId: row.thread_id,
          role: row.role,
          content: row.content,
          modelId: row.model_id,
          sources: row.sources ?? [],
          revision: row.revision,
          createdAt: row.created_at.toISOString(),
        },
        413,
      );
  return {
    revision: row.revision,
    deleted,
    payload,
    updatedAt: row.created_at.toISOString(),
  };
}

async function readNonPersonalState(
  client: PoolClient,
  ownerId: string,
  entityType: Exclude<SyncEntityType, PersonalEntityType>,
  entityId: string,
): Promise<AuthoritativeSyncState | null> {
  switch (entityType) {
    case "MEMORY": {
      const result = await client.query<MemoryRow>(
        `SELECT id,tier,scope,conversation_id,kind,title,content,importance::int,status,
                revision,expires_at,deleted_at,created_at,updated_at
           FROM memories
          WHERE id=$1 AND owner_id=$2 AND scope='PRIVATE'
          FOR UPDATE`,
        [entityId, ownerId],
      );
      return result.rows[0] ? memoryState(result.rows[0]) : null;
    }
    case "ASSISTANT": {
      const result = await client.query<AssistantRow>(
        `SELECT assistant.id,assistant.name,assistant.description,assistant.category,
                assistant.instructions,assistant.avatar_color,assistant.model_id,
                COALESCE(grant_row.cross_conversation_search,FALSE) AS cross_conversation_search,
                COALESCE(grant_row.private_memory_read,FALSE) AS private_memory_read,
                assistant.revision,assistant.deleted_at,assistant.created_at,assistant.updated_at
           FROM ai_assistants assistant
           LEFT JOIN assistant_tool_grants grant_row
             ON grant_row.assistant_id=assistant.id AND grant_row.owner_id=assistant.owner_id
          WHERE assistant.id=$1 AND assistant.owner_id=$2
          FOR UPDATE OF assistant`,
        [entityId, ownerId],
      );
      return result.rows[0] ? assistantState(result.rows[0]) : null;
    }
    case "ASSISTANT_THREAD": {
      const hierarchy = await client.query<{ assistant_id: string }>(
        `SELECT assistant_id FROM ai_assistant_threads WHERE id=$1 AND owner_id=$2`,
        [entityId, ownerId],
      );
      if (hierarchy.rows[0]) {
        await client.query(
          `SELECT id FROM ai_assistants
            WHERE id=$1 AND owner_id=$2
            FOR UPDATE`,
          [hierarchy.rows[0].assistant_id, ownerId],
        );
      }
      const result = await client.query<AssistantThreadRow>(
        `SELECT thread.id,thread.assistant_id,thread.title,thread.archived,thread.is_default,
                thread.revision,thread.deleted_at,thread.created_at,thread.updated_at
           FROM ai_assistant_threads thread
           JOIN ai_assistants assistant ON assistant.id=thread.assistant_id
          WHERE thread.id=$1 AND thread.owner_id=$2 AND assistant.owner_id=$2
          FOR UPDATE OF thread`,
        [entityId, ownerId],
      );
      return result.rows[0] ? assistantThreadState(result.rows[0]) : null;
    }
    case "ASSISTANT_MESSAGE": {
      const hierarchy = await client.query<{ assistant_id: string; thread_id: string }>(
        `SELECT message.assistant_id,message.thread_id
           FROM ai_assistant_messages message
           JOIN ai_assistants assistant ON assistant.id=message.assistant_id
          WHERE message.id=$1 AND assistant.owner_id=$2`,
        [entityId, ownerId],
      );
      if (hierarchy.rows[0]) {
        await client.query(
          `SELECT id FROM ai_assistants
            WHERE id=$1 AND owner_id=$2
            FOR UPDATE`,
          [hierarchy.rows[0].assistant_id, ownerId],
        );
        await client.query(
          `SELECT id FROM ai_assistant_threads
            WHERE id=$1 AND assistant_id=$2 AND owner_id=$3
            FOR UPDATE`,
          [hierarchy.rows[0].thread_id, hierarchy.rows[0].assistant_id, ownerId],
        );
      }
      const result = await client.query<AssistantMessageRow>(
        `SELECT message.id,message.assistant_id,message.thread_id,message.role,message.content,
                message.model_id,message.sources,message.revision,message.deleted_at,message.created_at
           FROM ai_assistant_messages message
           JOIN ai_assistants assistant ON assistant.id=message.assistant_id
          WHERE message.id=$1 AND assistant.owner_id=$2
          FOR UPDATE OF message`,
        [entityId, ownerId],
      );
      return result.rows[0] ? assistantMessageState(result.rows[0]) : null;
    }
  }
}

async function setBusinessRevision(
  client: PoolClient,
  entityType: Exclude<SyncEntityType, PersonalEntityType>,
  entityId: string,
  ownerId: string,
  revision: number,
): Promise<void> {
  switch (entityType) {
    case "MEMORY":
      await client.query(`UPDATE memories SET revision=$3 WHERE id=$1 AND owner_id=$2`, [
        entityId,
        ownerId,
        revision,
      ]);
      return;
    case "ASSISTANT":
      await client.query(`UPDATE ai_assistants SET revision=$3 WHERE id=$1 AND owner_id=$2`, [
        entityId,
        ownerId,
        revision,
      ]);
      return;
    case "ASSISTANT_THREAD":
      await client.query(
        `UPDATE ai_assistant_threads SET revision=$3 WHERE id=$1 AND owner_id=$2`,
        [entityId, ownerId, revision],
      );
      return;
    case "ASSISTANT_MESSAGE":
      await client.query(
        `UPDATE ai_assistant_messages message SET revision=$3
          FROM ai_assistants assistant
         WHERE message.id=$1 AND message.assistant_id=assistant.id AND assistant.owner_id=$2`,
        [entityId, ownerId, revision],
      );
  }
}

/**
 * 把真实业务行投影到同步流。业务行和快照同 revision 但内容不同，说明旧业务写入未接 hook；
 * 先提升真实业务 revision，再发布新 change，绝不让快照静默覆盖业务事实。
 */
export async function projectSyncEntity(
  client: PoolClient,
  ownerId: string,
  entityType: SyncEntityType,
  entityId: string,
): Promise<AuthoritativeSyncState | null> {
  let state = entityType.startsWith("PERSONAL_")
    ? await loadPersonalSyncState(client, ownerId, entityType as PersonalEntityType, entityId)
    : await readNonPersonalState(
        client,
        ownerId,
        entityType as Exclude<SyncEntityType, PersonalEntityType>,
        entityId,
      );
  const snapshot = await loadSyncSnapshot(client, ownerId, entityType, entityId, true);
  if (!state) {
    if (!snapshot) return null;
    if (snapshot.deleted_at) {
      return {
        revision: snapshot.revision,
        deleted: true,
        payload: snapshot.payload ?? {},
        updatedAt: snapshot.updated_at.toISOString(),
      };
    }
    const revision = snapshot.revision + 1;
    const payload = {
      id: entityId,
      revision,
      deletedAt: new Date().toISOString(),
    };
    const lastChange = await recordSyncSnapshot(
      client,
      ownerId,
      entityType,
      entityId,
      revision,
      payload,
      true,
    );
    return { revision, deleted: true, payload, updatedAt: payload.deletedAt, lastChange };
  }

  if (
    snapshot &&
    !snapshot.deleted_at &&
    snapshot.revision === state.revision &&
    !isDeepStrictEqual(snapshot.payload ?? {}, state.payload)
  ) {
    if (entityType.startsWith("PERSONAL_")) {
      throw new ApiError(409, "个人业务数据与同步投影版本冲突");
    }
    const revision = snapshot.revision + 1;
    await setBusinessRevision(
      client,
      entityType as Exclude<SyncEntityType, PersonalEntityType>,
      entityId,
      ownerId,
      revision,
    );
    state = { ...state, revision, payload: { ...state.payload, revision } };
  }
  const lastChange = await recordSyncSnapshot(
    client,
    ownerId,
    entityType,
    entityId,
    state.revision,
    state.payload,
    state.deleted,
  );
  return { ...state, lastChange };
}

async function assertConversationScope(
  _client: PoolClient,
  _ownerId: string,
  payload: MemorySyncPayload,
): Promise<void> {
  if (payload.scope !== "PRIVATE" || payload.conversationId !== null) {
    throw new ApiError(400, "移动端同步只支持私人记忆");
  }
}

async function assertModel(client: PoolClient, modelId: string | null): Promise<void> {
  if (!modelId) return;
  const found = await client.query(`SELECT 1 FROM ai_model_configs WHERE id=$1`, [modelId]);
  if (!found.rowCount) throw new ApiError(400, "同步的模型配置不存在");
}

async function assertAssistantThreadOwnership(
  client: PoolClient,
  ownerId: string,
  assistantId: string,
  threadId?: string,
  requireActive = false,
): Promise<void> {
  const assistant = await client.query(
    `SELECT id FROM ai_assistants
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [assistantId, ownerId],
  );
  if (!assistant.rowCount) throw new ApiError(400, "同步的助理或对话不存在");
  if (!threadId) return;
  const thread = await client.query(
    `SELECT id FROM ai_assistant_threads
      WHERE id=$1 AND assistant_id=$2 AND owner_id=$3 AND deleted_at IS NULL
        AND ($4::boolean=FALSE OR archived=FALSE)
      FOR UPDATE`,
    [threadId, assistantId, ownerId, requireActive],
  );
  if (!thread.rowCount) {
    throw new ApiError(
      400,
      requireActive ? "已归档的助理对话不能追加消息" : "同步的助理或对话不存在",
    );
  }
}

async function projectEntities(
  client: PoolClient,
  ownerId: string,
  entityType: "ASSISTANT_THREAD" | "ASSISTANT_MESSAGE",
  entityIds: string[],
): Promise<void> {
  for (const entityId of entityIds) {
    await projectSyncEntity(client, ownerId, entityType, entityId);
  }
}

/**
 * 消息和线程会改变助理列表及线程列表的排序信息，因此父级也必须递增 revision 并进入增量流。
 * 锁顺序固定为 assistant -> thread -> snapshot，和创建/删除层级保持一致。
 */
async function touchAssistantHierarchy(
  client: PoolClient,
  ownerId: string,
  assistantId: string,
  threadId?: string,
): Promise<void> {
  const assistant = await client.query<{ id: string }>(
    `UPDATE ai_assistants
        SET revision=revision+1,updated_at=NOW()
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      RETURNING id`,
    [assistantId, ownerId],
  );
  if (!assistant.rowCount) throw new ApiError(400, "同步的智能助理不存在");

  if (threadId) {
    const thread = await client.query<{ id: string }>(
      `UPDATE ai_assistant_threads
          SET revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND assistant_id=$2 AND owner_id=$3 AND deleted_at IS NULL
        RETURNING id`,
      [threadId, assistantId, ownerId],
    );
    if (!thread.rowCount) throw new ApiError(400, "同步的助理对话不存在");
  }

  await projectSyncEntity(client, ownerId, "ASSISTANT", assistantId);
  if (threadId) await projectSyncEntity(client, ownerId, "ASSISTANT_THREAD", threadId);
}

async function hardDeleteAssistant(
  client: PoolClient,
  ownerId: string,
  assistantId: string,
): Promise<void> {
  const threads = await client.query<{ id: string }>(
    `SELECT id FROM ai_assistant_threads
      WHERE assistant_id=$1 AND owner_id=$2
      ORDER BY id
      FOR UPDATE`,
    [assistantId, ownerId],
  );
  const messages = await client.query<{ id: string }>(
    `SELECT message.id
       FROM ai_assistant_messages message
       JOIN ai_assistants assistant ON assistant.id=message.assistant_id
      WHERE message.assistant_id=$1 AND assistant.owner_id=$2
      ORDER BY message.id
      FOR UPDATE OF message`,
    [assistantId, ownerId],
  );
  const attachments = await client.query<{ attachment_id: string }>(
    `SELECT assistant_file.attachment_id
       FROM ai_assistant_files assistant_file
      WHERE assistant_file.assistant_id=$1 AND assistant_file.owner_id=$2
      FOR SHARE OF assistant_file`,
    [assistantId, ownerId],
  );

  // 级联删除前必须先给所有可同步子实体建立快照，删除后才能可靠生成 tombstone。
  await projectSyncEntity(client, ownerId, "ASSISTANT", assistantId);
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_THREAD",
    threads.rows.map((row) => row.id),
  );
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_MESSAGE",
    messages.rows.map((row) => row.id),
  );

  const deleted = await client.query(
    `DELETE FROM ai_assistants WHERE id=$1 AND owner_id=$2 RETURNING id`,
    [assistantId, ownerId],
  );
  if (!deleted.rowCount) throw new ApiError(400, "同步的智能助理不存在");

  await stageDetachedAttachmentsForCleanup(
    client,
    attachments.rows.map((row) => row.attachment_id),
  );
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_MESSAGE",
    messages.rows.map((row) => row.id),
  );
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_THREAD",
    threads.rows.map((row) => row.id),
  );
}

async function hardDeleteAssistantThread(
  client: PoolClient,
  ownerId: string,
  threadId: string,
): Promise<void> {
  const candidate = await client.query<{ assistant_id: string }>(
    `SELECT assistant_id FROM ai_assistant_threads
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
    [threadId, ownerId],
  );
  if (!candidate.rows[0]) throw new ApiError(400, "同步的助理对话不存在");
  await assertAssistantThreadOwnership(client, ownerId, candidate.rows[0].assistant_id, threadId);
  const target = await client.query<{ assistant_id: string; is_default: boolean }>(
    `SELECT assistant_id,is_default
       FROM ai_assistant_threads
      WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [threadId, ownerId],
  );
  const thread = target.rows[0];
  if (!thread) throw new ApiError(400, "同步的助理对话不存在");

  const replacement = await client.query<{ id: string }>(
    `SELECT id FROM ai_assistant_threads
      WHERE assistant_id=$1 AND owner_id=$2 AND id<>$3
        AND archived=FALSE AND deleted_at IS NULL
      ORDER BY is_default DESC,created_at,id
      LIMIT 1
      FOR UPDATE`,
    [thread.assistant_id, ownerId, threadId],
  );
  if (!replacement.rows[0]) throw new ApiError(400, "至少需要保留一条助理对话");

  const messages = await client.query<{ id: string }>(
    `SELECT id FROM ai_assistant_messages
      WHERE thread_id=$1
      ORDER BY id
      FOR UPDATE`,
    [threadId],
  );
  await projectSyncEntity(client, ownerId, "ASSISTANT_THREAD", threadId);
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_MESSAGE",
    messages.rows.map((row) => row.id),
  );

  await client.query(`DELETE FROM ai_assistant_threads WHERE id=$1 AND owner_id=$2`, [
    threadId,
    ownerId,
  ]);
  await projectEntities(
    client,
    ownerId,
    "ASSISTANT_MESSAGE",
    messages.rows.map((row) => row.id),
  );

  if (thread.is_default) {
    await client.query(
      `UPDATE ai_assistant_threads
          SET is_default=TRUE,revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND assistant_id=$2 AND owner_id=$3 AND deleted_at IS NULL`,
      [replacement.rows[0].id, thread.assistant_id, ownerId],
    );
    await projectSyncEntity(client, ownerId, "ASSISTANT_THREAD", replacement.rows[0].id);
  }
  await touchAssistantHierarchy(client, ownerId, thread.assistant_id);
}

async function hardDeleteAssistantMessage(
  client: PoolClient,
  ownerId: string,
  messageId: string,
): Promise<void> {
  await projectSyncEntity(client, ownerId, "ASSISTANT_MESSAGE", messageId);
  const deleted = await client.query<{ assistant_id: string; thread_id: string }>(
    `DELETE FROM ai_assistant_messages message
      USING ai_assistants assistant
      WHERE message.id=$1 AND message.assistant_id=assistant.id AND assistant.owner_id=$2
      RETURNING message.assistant_id,message.thread_id`,
    [messageId, ownerId],
  );
  const message = deleted.rows[0];
  if (!message) throw new ApiError(400, "同步的助理消息不存在");
  await touchAssistantHierarchy(client, ownerId, message.assistant_id, message.thread_id);
}

export async function applyAuthoritativeSyncOperation(
  client: PoolClient,
  ownerId: string,
  operation: SyncOperation,
  revision: number,
): Promise<SyncChange> {
  if (operation.entityType.startsWith("PERSONAL_")) {
    return applyPersonalSyncOperation(
      client,
      ownerId,
      operation as SyncOperation & { entityType: PersonalEntityType },
      revision,
    );
  }

  if (operation.operation === "DELETE") {
    switch (operation.entityType) {
      case "MEMORY":
        await client.query(
          `UPDATE memories
              SET status='DELETED',deleted_at=NOW(),revision=$3,updated_at=NOW()
            WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
          [operation.entityId, ownerId, revision],
        );
        await client.query(
          `INSERT INTO memory_revisions
             (id,memory_id,revision,kind,title,content,importance,change_type,changed_by)
           SELECT gen_random_uuid(),id,revision,kind,title,content,importance,'FORGET',$2
             FROM memories WHERE id=$1 AND owner_id=$2`,
          [operation.entityId, ownerId],
        );
        break;
      case "ASSISTANT":
        await hardDeleteAssistant(client, ownerId, operation.entityId);
        break;
      case "ASSISTANT_THREAD":
        await hardDeleteAssistantThread(client, ownerId, operation.entityId);
        break;
      case "ASSISTANT_MESSAGE":
        await hardDeleteAssistantMessage(client, ownerId, operation.entityId);
        break;
    }
  } else {
    switch (operation.entityType) {
      case "MEMORY": {
        const payload = parseSyncEntityPayload("MEMORY", operation.payload) as MemorySyncPayload;
        await assertConversationScope(client, ownerId, payload);
        const result = await client.query(
          operation.baseRevision === null
            ? `INSERT INTO memories
                 (id,owner_id,tier,scope,conversation_id,kind,title,content,importance,status,
                  revision,expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                       CASE WHEN $3::varchar = 'SHORT_TERM'
                            THEN NOW() + INTERVAL '7 days'
                            ELSE NULL END)`
            : `UPDATE memories
                  SET tier=$3,scope=$4,conversation_id=$5,kind=$6,title=$7,content=$8,
                      importance=$9,status=$10,revision=$11,
                      expires_at=CASE
                        WHEN $3::varchar = 'LONG_TERM' THEN NULL
                        WHEN tier='SHORT_TERM' AND expires_at IS NOT NULL THEN expires_at
                        ELSE NOW() + INTERVAL '7 days'
                      END,
                      updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
          [
            operation.entityId,
            ownerId,
            payload.tier,
            payload.scope,
            payload.conversationId,
            payload.kind,
            payload.title,
            payload.content,
            payload.importance,
            payload.status,
            revision,
          ],
        );
        if (operation.baseRevision !== null && !result.rowCount)
          throw new ApiError(409, "记忆已被其他设备更新");
        await client.query(
          `INSERT INTO memory_revisions
             (id,memory_id,revision,kind,title,content,importance,change_type,changed_by)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            operation.entityId,
            revision,
            payload.kind,
            payload.title,
            payload.content,
            payload.importance,
            operation.baseRevision === null ? "CREATE" : "CORRECT",
            ownerId,
          ],
        );
        if (operation.baseRevision === null) {
          // 移动端同步协议不接收可伪造的来源字段。离线手工新建的记忆由服务端补一条
          // MANUAL 来源；后续修订和遗忘只修改记忆事实，不改写这条创建来源。
          await client.query(
            `INSERT INTO memory_sources
               (id,memory_id,source_type,label,source_created_at)
             VALUES (gen_random_uuid(),$1,'MANUAL','移动端手动创建',NOW())`,
            [operation.entityId],
          );
        }
        break;
      }
      case "ASSISTANT": {
        const payload = parseSyncEntityPayload(
          "ASSISTANT",
          operation.payload,
        ) as AssistantSyncPayload;
        await assertModel(client, payload.modelId);
        if (operation.baseRevision === null) {
          const count = await client.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM ai_assistants
              WHERE owner_id=$1 AND deleted_at IS NULL`,
            [ownerId],
          );
          if (Number(count.rows[0]?.total ?? 0) >= 20)
            throw new ApiError(400, "最多可创建 20 个智能助理");
        }
        const result = await client.query(
          operation.baseRevision === null
            ? `INSERT INTO ai_assistants
                 (id,owner_id,name,description,category,instructions,avatar_color,model_id,revision)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
            : `UPDATE ai_assistants
                  SET name=$3,description=$4,category=$5,instructions=$6,avatar_color=$7,
                      model_id=$8,revision=$9,updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
          [
            operation.entityId,
            ownerId,
            payload.name,
            payload.description,
            payload.category,
            payload.instructions,
            payload.avatarColor,
            payload.modelId,
            revision,
          ],
        );
        if (operation.baseRevision !== null && !result.rowCount)
          throw new ApiError(409, "智能助理已被其他设备更新");
        // 移动端只能创建默认拒绝的授权行；任何客户端 payload 中的 toolGrants 已被解析层丢弃。
        await client.query(
          `INSERT INTO assistant_tool_grants (assistant_id,owner_id)
           VALUES ($1,$2)
           ON CONFLICT (assistant_id) DO NOTHING`,
          [operation.entityId, ownerId],
        );
        break;
      }
      case "ASSISTANT_THREAD": {
        const payload = parseSyncEntityPayload(
          "ASSISTANT_THREAD",
          operation.payload,
        ) as AssistantThreadSyncPayload;
        await assertAssistantThreadOwnership(client, ownerId, payload.assistantId);
        const existingThreads = await client.query<{
          id: string;
          archived: boolean;
          is_default: boolean;
        }>(
          `SELECT id,archived,is_default FROM ai_assistant_threads
            WHERE assistant_id=$1 AND owner_id=$2 AND deleted_at IS NULL
            ORDER BY id FOR UPDATE`,
          [payload.assistantId, ownerId],
        );
        const current = existingThreads.rows.find((thread) => thread.id === operation.entityId);
        if (operation.baseRevision === null) {
          if (existingThreads.rows.length >= 30)
            throw new ApiError(400, "每个助理最多保留 30 条对话");
          const hasDefault = existingThreads.rows.some((thread) => thread.is_default);
          if (payload.isDefault === hasDefault) {
            throw new ApiError(
              400,
              hasDefault ? "助理只能有一条默认对话" : "首条助理对话必须设为默认",
            );
          }
          if (payload.archived && !existingThreads.rows.some((thread) => !thread.archived)) {
            throw new ApiError(400, "至少需要保留一条未归档的助理对话");
          }
        } else {
          if (!current) throw new ApiError(409, "助理对话已被其他设备更新");
          if (payload.isDefault !== current.is_default) {
            throw new ApiError(400, "默认对话标识不能通过同步修改");
          }
          if (
            payload.archived &&
            !current.archived &&
            existingThreads.rows.filter((thread) => !thread.archived).length <= 1
          ) {
            throw new ApiError(400, "至少需要保留一条未归档的助理对话");
          }
        }
        const result = await client.query(
          operation.baseRevision === null
            ? `INSERT INTO ai_assistant_threads
                 (id,assistant_id,owner_id,title,archived,is_default,revision)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`
            : `UPDATE ai_assistant_threads
                  SET title=$4,archived=$5,is_default=$6,revision=$7,updated_at=NOW()
                WHERE id=$1 AND assistant_id=$2 AND owner_id=$3 AND deleted_at IS NULL`,
          [
            operation.entityId,
            payload.assistantId,
            ownerId,
            payload.title,
            payload.archived,
            payload.isDefault,
            revision,
          ],
        );
        if (operation.baseRevision !== null && !result.rowCount)
          throw new ApiError(409, "助理对话已被其他设备更新");
        await touchAssistantHierarchy(client, ownerId, payload.assistantId);
        break;
      }
      case "ASSISTANT_MESSAGE": {
        if (operation.baseRevision !== null)
          throw new ApiError(409, "助理消息只能按 UUID 追加，不能覆盖");
        const payload = parseSyncEntityPayload(
          "ASSISTANT_MESSAGE",
          operation.payload,
        ) as AssistantMessageSyncPayload;
        await assertAssistantThreadOwnership(
          client,
          ownerId,
          payload.assistantId,
          payload.threadId,
          true,
        );
        await assertModel(client, payload.modelId);
        await client.query(
          `INSERT INTO ai_assistant_messages
             (id,assistant_id,thread_id,role,content,model_id,sources,revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            operation.entityId,
            payload.assistantId,
            payload.threadId,
            payload.role,
            payload.content,
            payload.modelId,
            // 外部设备提供的 sources 只用于同步 DTO，不能进入服务器可追溯来源或权限判断。
            JSON.stringify([]),
            revision,
          ],
        );
        await touchAssistantHierarchy(client, ownerId, payload.assistantId, payload.threadId);
        break;
      }
    }
  }

  const state = await projectSyncEntity(client, ownerId, operation.entityType, operation.entityId);
  if (!state) throw new ApiError(409, "同步业务实体写入失败");
  if (!state.lastChange) throw new ApiError(409, "同步操作没有产生新的投影变更");
  return state.lastChange;
}

export interface SyncProjectionBackfillCursor {
  entityType: SyncEntityType;
  entityId: string;
}

export interface SyncProjectionBackfillPage {
  processed: number;
  hasMore: boolean;
  nextCursor: SyncProjectionBackfillCursor | null;
}

const projectionBackfillSources: ReadonlyArray<{ type: SyncEntityType; sql: string }> = [
  { type: "MEMORY", sql: `SELECT id FROM memories WHERE owner_id=$1 AND scope='PRIVATE'` },
  { type: "PERSONAL_TASK", sql: `SELECT id FROM personal_tasks WHERE owner_id=$1` },
  { type: "PERSONAL_REMINDER", sql: `SELECT id FROM personal_reminders WHERE owner_id=$1` },
  { type: "PERSONAL_RECORD", sql: `SELECT id FROM personal_records WHERE owner_id=$1` },
  { type: "ASSISTANT", sql: `SELECT id FROM ai_assistants WHERE owner_id=$1` },
  { type: "ASSISTANT_THREAD", sql: `SELECT id FROM ai_assistant_threads WHERE owner_id=$1` },
  {
    type: "ASSISTANT_MESSAGE",
    sql: `SELECT message.id FROM ai_assistant_messages message
           JOIN ai_assistants assistant ON assistant.id=message.assistant_id
          WHERE assistant.owner_id=$1`,
  },
];

/**
 * bootstrap 前按稳定的 entity_type/entity_id keyset 补齐业务投影和遗留 tombstone。
 * 每次最多投影 limit 个实体，调用方把 nextCursor 放进签名 token 后跨事务续传，禁止
 * 再把一个 owner 的全部实体加载进单个事务。
 */
export async function refreshOwnerSyncProjectionPage(
  client: PoolClient,
  ownerId: string,
  after: SyncProjectionBackfillCursor | null,
  limit: number,
): Promise<SyncProjectionBackfillPage> {
  if (!Number.isInteger(limit) || limit <= 0) throw new ApiError(500, "同步投影分页上限无效");
  const startIndex = after
    ? projectionBackfillSources.findIndex((source) => source.type === after.entityType)
    : 0;
  if (startIndex < 0) throw new ApiError(400, "bootstrap 投影游标无效，请重新开始");

  let processed = 0;
  let nextCursor: SyncProjectionBackfillCursor | null = after;
  for (let index = startIndex; index < projectionBackfillSources.length; index += 1) {
    const source = projectionBackfillSources[index]!;
    const afterId =
      index === startIndex && after?.entityType === source.type ? after.entityId : null;
    const remaining = limit - processed;
    const candidates = await client.query<{ id: string }>(
      `SELECT id
         FROM (
           ${source.sql}
           UNION
           SELECT entity_id AS id
             FROM sync_entity_snapshots
            WHERE owner_id=$1 AND entity_type=$4
         ) candidate
        WHERE ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id
        LIMIT $3`,
      [ownerId, afterId, remaining + 1, source.type],
    );
    const pageRows = candidates.rows.slice(0, remaining);
    for (const row of pageRows) {
      await projectSyncEntity(client, ownerId, source.type, row.id);
      nextCursor = { entityType: source.type, entityId: row.id };
      processed += 1;
    }
    if (candidates.rows.length > remaining) {
      return { processed, hasMore: true, nextCursor };
    }
    if (processed === limit) {
      const hasLaterEntityTypes = index < projectionBackfillSources.length - 1;
      return {
        processed,
        hasMore: hasLaterEntityTypes,
        nextCursor: hasLaterEntityTypes ? nextCursor : null,
      };
    }
  }
  return { processed, hasMore: false, nextCursor: null };
}
