import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";

const ASSISTANT_THREAD_LIMIT = 30;

export interface AssistantThreadRow {
  id: string;
  assistant_id: string;
  owner_id: string;
  title: string;
  archived: boolean;
  is_default: boolean;
  message_count: string;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const THREAD_COLUMNS = `
  thread.id, thread.assistant_id, thread.owner_id, thread.title,
  thread.archived, thread.is_default,
  (SELECT COUNT(*)::text FROM ai_assistant_messages message
    WHERE message.thread_id = thread.id) AS message_count,
  (SELECT MAX(message.created_at) FROM ai_assistant_messages message
    WHERE message.thread_id = thread.id) AS last_message_at,
  thread.created_at, thread.updated_at`;

function publicThread(row: AssistantThreadRow) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title,
    archived: row.archived,
    isDefault: row.is_default,
    messageCount: Number(row.message_count),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 同时校验助理、线程和所有者，避免使用其他助理的 threadId 进行越权读取。 */
export async function selectAiAssistantThread(
  userId: string,
  assistantId: string,
  threadId: string,
  client?: PoolClient,
  lock = false,
): Promise<AssistantThreadRow> {
  const statement = `SELECT ${THREAD_COLUMNS}
     FROM ai_assistant_threads thread
     JOIN ai_assistants assistant ON assistant.id = thread.assistant_id
    WHERE thread.id = $1 AND thread.assistant_id = $2
      AND thread.owner_id = $3 AND assistant.owner_id = $3
    ${lock ? "FOR UPDATE OF thread" : ""}`;
  const result = client
    ? await client.query<AssistantThreadRow>(statement, [threadId, assistantId, userId])
    : await query<AssistantThreadRow>(statement, [threadId, assistantId, userId]);
  if (!result.rows[0]) throw new ApiError(404, "助理对话不存在");
  return result.rows[0];
}

export async function requireActiveAiAssistantThread(
  userId: string,
  assistantId: string,
  threadId: string,
  client?: PoolClient,
  lock = false,
): Promise<AssistantThreadRow> {
  const thread = await selectAiAssistantThread(userId, assistantId, threadId, client, lock);
  if (thread.archived) throw new ApiError(409, "该助理对话已归档，请先恢复后再继续");
  return thread;
}

export async function createDefaultAiAssistantThread(
  client: PoolClient,
  userId: string,
  assistantId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO ai_assistant_threads
       (id, assistant_id, owner_id, title, is_default)
     VALUES ($1, $2, $3, '默认对话', TRUE)`,
    [id, assistantId, userId],
  );
  return id;
}

export async function defaultAiAssistantThreadId(
  userId: string,
  assistantId: string,
): Promise<string> {
  const result = await query<{ id: string }>(
    `SELECT thread.id
       FROM ai_assistant_threads thread
       JOIN ai_assistants assistant ON assistant.id = thread.assistant_id
      WHERE thread.assistant_id = $1 AND thread.owner_id = $2 AND assistant.owner_id = $2
      ORDER BY thread.archived, thread.is_default DESC,
               COALESCE(
                 (SELECT MAX(message.created_at) FROM ai_assistant_messages message
                   WHERE message.thread_id = thread.id),
                 thread.updated_at
               ) DESC,
               thread.created_at
      LIMIT 1`,
    [assistantId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "智能助理不存在或尚未初始化对话");
  return result.rows[0].id;
}

export async function listAiAssistantThreads(
  userId: string,
  assistantId: string,
  includeArchived = false,
) {
  const result = await query<AssistantThreadRow>(
    `SELECT ${THREAD_COLUMNS}
       FROM ai_assistant_threads thread
       JOIN ai_assistants assistant ON assistant.id = thread.assistant_id
      WHERE thread.assistant_id = $1 AND thread.owner_id = $2 AND assistant.owner_id = $2
        AND ($3::boolean OR thread.archived = FALSE)
      ORDER BY thread.archived,
               COALESCE(
                 (SELECT MAX(message.created_at) FROM ai_assistant_messages message
                   WHERE message.thread_id = thread.id),
                 thread.updated_at
               ) DESC,
               thread.created_at DESC`,
    [assistantId, userId, includeArchived],
  );
  return result.rows.map(publicThread);
}

export async function createAiAssistantThread(userId: string, assistantId: string, title: string) {
  const threadId = await transaction(async (client) => {
    const assistant = await client.query(
      `SELECT id FROM ai_assistants WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [assistantId, userId],
    );
    if (!assistant.rowCount) throw new ApiError(404, "智能助理不存在");
    const count = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ai_assistant_threads
        WHERE assistant_id = $1 AND owner_id = $2`,
      [assistantId, userId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_THREAD_LIMIT) {
      throw new ApiError(400, `每个助理最多保留 ${ASSISTANT_THREAD_LIMIT} 条对话`);
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_threads (id, assistant_id, owner_id, title)
       VALUES ($1, $2, $3, $4)`,
      [id, assistantId, userId, title],
    );
    await client.query(`UPDATE ai_assistants SET updated_at = NOW() WHERE id = $1`, [assistantId]);
    return id;
  });
  return publicThread(await selectAiAssistantThread(userId, assistantId, threadId));
}

export async function updateAiAssistantThread(
  userId: string,
  assistantId: string,
  threadId: string,
  input: { title?: string; archived?: boolean },
) {
  await transaction(async (client) => {
    const current = await selectAiAssistantThread(userId, assistantId, threadId, client, true);
    const archived = input.archived ?? current.archived;
    if (archived && !current.archived) {
      const active = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ai_assistant_threads
          WHERE assistant_id = $1 AND owner_id = $2 AND archived = FALSE`,
        [assistantId, userId],
      );
      if (Number(active.rows[0]?.total ?? 0) <= 1) {
        throw new ApiError(409, "至少需要保留一条未归档的助理对话");
      }
      // 归档后不再让后台任务悄悄向隐藏时间线写入结果。
      await client.query(
        `UPDATE ai_assistant_tasks
            SET enabled = FALSE, run_requested_at = NULL, updated_at = NOW()
          WHERE thread_id = $1 AND owner_id = $2`,
        [threadId, userId],
      );
    }
    await client.query(
      `UPDATE ai_assistant_threads
          SET title = $4, archived = $5, updated_at = NOW()
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3`,
      [threadId, assistantId, userId, input.title ?? current.title, archived],
    );
    await client.query(`UPDATE ai_assistants SET updated_at = NOW() WHERE id = $1`, [assistantId]);
  });
  return publicThread(await selectAiAssistantThread(userId, assistantId, threadId));
}

export async function findAiAssistantMessageThread(
  userId: string,
  assistantId: string,
  messageId: string,
): Promise<string> {
  const result = await query<{ thread_id: string }>(
    `SELECT message.thread_id
       FROM ai_assistant_messages message
       JOIN ai_assistants assistant ON assistant.id = message.assistant_id
      WHERE message.id = $1 AND message.assistant_id = $2 AND assistant.owner_id = $3`,
    [messageId, assistantId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "助理消息不存在");
  return result.rows[0].thread_id;
}
