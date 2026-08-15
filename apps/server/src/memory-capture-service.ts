import { randomUUID } from "node:crypto";
import type { MemoryKind } from "@near-chat/contracts";
import { z } from "zod";
import { generateConversationMemoryCandidates, getAiCapabilities } from "./ai/ai-runtime.js";
import { config } from "./config.js";
import { query, transaction } from "./database.js";
import {
  archiveExpiredShortTermMemories,
  createGeneratedMemoryCandidate,
} from "./memory-service.js";

const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 1_600;
const MAX_JOB_ATTEMPTS = 4;
const ARCHIVE_INTERVAL_MS = 60_000;

const generatedCandidateSchema = z
  .array(
    z.object({
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
    }),
  )
  .max(5);

export interface GeneratedMemoryCandidateDraft {
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
}

export interface MemoryCaptureMessage {
  id: string;
  conversation_id: string;
  text_content: string | null;
  recalled_at: Date | null;
  created_at: Date;
  sender_name: string;
  conversation_title: string;
  attachment_names: string[];
}

interface PreparedMemoryCaptureBatch {
  transcript: string;
  source: MemoryCaptureMessage | null;
}

interface CaptureStateRow {
  owner_id: string;
  conversation_id: string;
  message_ids: string[];
}

interface CaptureJobRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  message_ids: string[];
  attempts: number;
}

/** 在发送给外部模型前遮盖常见凭据；原聊天正文与数据库记录保持不变。 */
export function redactMemoryCaptureText(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "[已隐藏密钥]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu, "Bearer [已隐藏令牌]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[已隐藏令牌]")
    .replace(
      /((?:api[-_ ]?key|password|passwd|token|secret|密码|口令|密钥)\s*[:=：]\s*)([^\s,，;；]+)/giu,
      "$1[已隐藏]",
    );
}

/** 兼容模型偶尔附带解释或代码围栏，但最终数据仍必须通过严格 Schema。 */
export function parseGeneratedMemoryCandidates(raw: string): GeneratedMemoryCandidateDraft[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("模型未返回 JSON 候选数组");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的记忆候选不是有效 JSON");
  }
  const result = generatedCandidateSchema.safeParse(parsed);
  if (!result.success) throw new Error("模型返回的记忆候选字段不完整");
  return result.data;
}

/**
 * 会话批次只保留模型判断所需的文字和附件名，并设置双重字符上限。原消息 ID
 * 不进入提示词，最终来源定位由服务端保存的批次元数据完成。
 */
function prepareMemoryCaptureBatch(messages: MemoryCaptureMessage[]): PreparedMemoryCaptureBatch {
  const lines: string[] = [];
  let total = 0;
  let source: MemoryCaptureMessage | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.recalled_at) continue;
    const attachments = message.attachment_names.length
      ? ` [附件：${redactMemoryCaptureText(message.attachment_names.join("、"))}]`
      : "";
    const body = redactMemoryCaptureText(
      (message.text_content?.trim() || "（无文字消息）").replaceAll("\u0000", ""),
    ).slice(0, MAX_MESSAGE_CHARS);
    const line = `[${index + 1}] ${message.created_at.toISOString()} ${message.sender_name}：${body}${attachments}`;
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    total += line.length + 1;
    source = message;
  }
  return { transcript: lines.join("\n"), source };
}

export function buildMemoryCaptureTranscript(messages: MemoryCaptureMessage[]): string {
  return prepareMemoryCaptureBatch(messages).transcript;
}

/**
 * 新消息写入成功后调用。只有显式开启智能整理的会话成员会产生状态行，重复消息
 * ID 不会再次计数；达到阈值立即到期，否则按最后一条消息重新计算静默时间。
 */
export async function observeConversationMessageForMemory(
  conversationId: string,
  messageId: string,
): Promise<number> {
  const result = await query(
    `INSERT INTO memory_capture_states
       (owner_id, conversation_id, message_ids, message_count,
        first_message_at, last_message_at, due_at)
     SELECT member.user_id,
            message.conversation_id,
            ARRAY[message.id]::uuid[],
            1,
            message.created_at,
            message.created_at,
            CASE
              WHEN $3::int <= 1 THEN NOW()
              ELSE message.created_at + ($4::int * INTERVAL '1 minute')
            END
       FROM messages message
       JOIN conversation_members member ON member.conversation_id = message.conversation_id
       JOIN memory_settings settings
         ON settings.owner_id = member.user_id AND settings.semantic_capture_enabled = TRUE
      WHERE message.id = $2 AND message.conversation_id = $1 AND message.recalled_at IS NULL
     ON CONFLICT (owner_id, conversation_id) DO UPDATE
       SET message_ids = CASE
             WHEN $2::uuid = ANY(memory_capture_states.message_ids)
               THEN memory_capture_states.message_ids
             ELSE array_append(memory_capture_states.message_ids, $2::uuid)
           END,
           message_count = CASE
             WHEN $2::uuid = ANY(memory_capture_states.message_ids)
               THEN memory_capture_states.message_count
             ELSE memory_capture_states.message_count + 1
           END,
           first_message_at = LEAST(
             memory_capture_states.first_message_at,
             EXCLUDED.first_message_at
           ),
           last_message_at = GREATEST(
             memory_capture_states.last_message_at,
             EXCLUDED.last_message_at
           ),
           due_at = CASE
             WHEN $2::uuid = ANY(memory_capture_states.message_ids)
               THEN memory_capture_states.due_at
             WHEN memory_capture_states.message_count + 1 >= $3::int THEN NOW()
             ELSE EXCLUDED.last_message_at + ($4::int * INTERVAL '1 minute')
           END,
           updated_at = NOW()`,
    [conversationId, messageId, config.ai.memory.messageThreshold, config.ai.memory.silenceMinutes],
  );
  return result.rowCount ?? 0;
}

async function queueDueCaptureJobs(): Promise<number> {
  return transaction(async (client) => {
    const due = await client.query<CaptureStateRow>(
      `SELECT state.owner_id, state.conversation_id, state.message_ids
         FROM memory_capture_states state
         JOIN memory_settings settings ON settings.owner_id = state.owner_id
        WHERE state.due_at <= NOW() AND settings.semantic_capture_enabled = TRUE
        ORDER BY state.due_at, state.updated_at
        LIMIT 50
        FOR UPDATE OF state SKIP LOCKED`,
    );
    for (const state of due.rows) {
      await client.query(
        `INSERT INTO memory_capture_jobs
           (id, owner_id, conversation_id, message_ids)
         VALUES ($1, $2, $3, $4::uuid[])`,
        [randomUUID(), state.owner_id, state.conversation_id, state.message_ids],
      );
      await client.query(
        `DELETE FROM memory_capture_states
          WHERE owner_id = $1 AND conversation_id = $2`,
        [state.owner_id, state.conversation_id],
      );
    }
    return due.rows.length;
  });
}

async function claimCaptureJob(): Promise<CaptureJobRow | null> {
  return transaction(async (client) => {
    const due = await client.query<CaptureJobRow>(
      `SELECT job.id, job.owner_id, job.conversation_id, job.message_ids, job.attempts
         FROM memory_capture_jobs job
         JOIN memory_settings settings
           ON settings.owner_id = job.owner_id AND settings.semantic_capture_enabled = TRUE
        WHERE (job.status = 'QUEUED' AND job.next_attempt_at <= NOW())
           OR (job.status = 'RUNNING' AND job.updated_at < NOW() - INTERVAL '15 minutes')
        ORDER BY job.created_at, job.id
        LIMIT 1
        FOR UPDATE OF job SKIP LOCKED`,
    );
    const job = due.rows[0];
    if (!job) return null;
    const claimed = await client.query<CaptureJobRow>(
      `UPDATE memory_capture_jobs
          SET status = 'RUNNING', attempts = attempts + 1,
              error_message = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING id, owner_id, conversation_id, message_ids, attempts`,
      [job.id],
    );
    return claimed.rows[0] ?? null;
  });
}

async function loadCaptureMessages(job: CaptureJobRow): Promise<MemoryCaptureMessage[]> {
  const result = await query<MemoryCaptureMessage>(
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
       JOIN memory_settings settings
         ON settings.owner_id = member.user_id AND settings.semantic_capture_enabled = TRUE
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
      WHERE message.conversation_id = $1
        AND message.id = ANY($3::uuid[])
        AND message.recalled_at IS NULL
      GROUP BY message.id, sender.display_name, conversation.name
      ORDER BY array_position($3::uuid[], message.id)`,
    [job.conversation_id, job.owner_id, job.message_ids],
  );
  return result.rows;
}

async function captureStillEnabled(ownerId: string, conversationId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
       FROM memory_settings settings
       JOIN conversation_members member ON member.user_id = settings.owner_id
      WHERE settings.owner_id = $1
        AND settings.semantic_capture_enabled = TRUE
        AND member.conversation_id = $2`,
    [ownerId, conversationId],
  );
  return Boolean(result.rowCount);
}

async function completeCaptureJob(jobId: string): Promise<void> {
  await query(
    `UPDATE memory_capture_jobs
        SET status = 'COMPLETED', error_message = NULL,
            completed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [jobId],
  );
}

async function failCaptureJob(job: CaptureJobRow, error: unknown): Promise<void> {
  const retry = job.attempts < MAX_JOB_ATTEMPTS;
  const retrySeconds = Math.min(300, 2 ** job.attempts * 15);
  const message = (error instanceof Error ? error.message : "记忆整理任务失败").slice(0, 500);
  await query(
    `UPDATE memory_capture_jobs
        SET status = $2::varchar,
            next_attempt_at = CASE
              WHEN $2::varchar = 'QUEUED'::varchar
                THEN NOW() + ($3::double precision * INTERVAL '1 second')
              ELSE next_attempt_at
            END,
            error_message = $4,
            completed_at = CASE WHEN $2::varchar = 'FAILED'::varchar THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, retry ? "QUEUED" : "FAILED", retrySeconds, message],
  );
  console.warn(`Memory capture job ${job.id} failed: ${message}`);
}

async function processCaptureJob(job: CaptureJobRow): Promise<void> {
  try {
    const messages = await loadCaptureMessages(job);
    const { transcript, source } = prepareMemoryCaptureBatch(messages);
    if (!transcript) {
      await completeCaptureJob(job.id);
      return;
    }
    const generated = parseGeneratedMemoryCandidates(
      await generateConversationMemoryCandidates(transcript),
    );
    if (!(await captureStillEnabled(job.owner_id, job.conversation_id))) {
      await completeCaptureJob(job.id);
      return;
    }
    if (!source) {
      await completeCaptureJob(job.id);
      return;
    }
    for (const candidate of generated) {
      await createGeneratedMemoryCandidate(job.owner_id, {
        ...candidate,
        sourceMessageId: source.id,
        conversationId: job.conversation_id,
        sourceLabel: `${source.conversation_title} · 智能整理`,
        sourceExcerpt: [
          source.text_content?.trim() ? redactMemoryCaptureText(source.text_content.trim()) : "",
          source.attachment_names.length ? `附件：${source.attachment_names.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 1_000),
        sourceCreatedAt: source.created_at,
      });
    }
    await completeCaptureJob(job.id);
  } catch (error) {
    await failCaptureJob(job, error);
  }
}

async function cleanupCaptureJobs(): Promise<void> {
  await query(
    `DELETE FROM memory_capture_jobs job
      WHERE (
        job.status IN ('QUEUED', 'FAILED')
        OR (job.status = 'RUNNING' AND job.updated_at < NOW() - INTERVAL '15 minutes')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_settings settings
         WHERE settings.owner_id = job.owner_id
           AND settings.semantic_capture_enabled = TRUE
      )`,
  );
  await query(
    `DELETE FROM memory_capture_jobs
      WHERE status IN ('COMPLETED', 'FAILED')
        AND updated_at < NOW() - INTERVAL '7 days'`,
  );
}

/**
 * PostgreSQL 持久化的小型后台任务器。没有模型时只保留待处理批次并继续做过期归档，
 * 不认领 AI 任务，也不会影响消息发送、手动记忆或关键词检索。
 */
export function startMemoryCaptureWorker(): () => void {
  let running = false;
  let stopped = false;
  let lastArchiveAt = 0;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await queueDueCaptureJobs();
      await cleanupCaptureJobs();
      const now = Date.now();
      if (now - lastArchiveAt >= ARCHIVE_INTERVAL_MS) {
        await archiveExpiredShortTermMemories();
        lastArchiveAt = now;
      }
      if (getAiCapabilities().features.messageActions) {
        for (let count = 0; count < 3 && !stopped; count += 1) {
          const job = await claimCaptureJob();
          if (!job) break;
          await processCaptureJob(job);
        }
      }
    } catch (error) {
      console.error("Memory capture worker cycle failed:", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, config.ai.memory.pollMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
