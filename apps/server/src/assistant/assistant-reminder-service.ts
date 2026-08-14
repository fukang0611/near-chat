import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import { requireActiveAiAssistantThread } from "./assistant-thread-service.js";

const ASSISTANT_REMINDER_LIMIT = 100;
const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export interface SaveAiAssistantReminderInput {
  threadId: string;
  title: string;
  note: string;
  scheduledAt: Date;
}

export interface UpdateAiAssistantReminderInput {
  title?: string;
  note?: string;
  scheduledAt?: Date;
  completed?: boolean;
}

interface AssistantReminderRow {
  id: string;
  assistant_id: string;
  thread_id: string;
  owner_id: string;
  thread_title: string;
  thread_archived: boolean;
  title: string;
  note: string;
  scheduled_at: Date;
  completed_at: Date | null;
  notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const REMINDER_COLUMNS = `
  reminder.id, reminder.assistant_id, reminder.thread_id, reminder.owner_id,
  thread.title AS thread_title, thread.archived AS thread_archived,
  reminder.title, reminder.note, reminder.scheduled_at,
  reminder.completed_at, reminder.notified_at,
  reminder.created_at, reminder.updated_at`;

export function reminderStatus(
  row: Pick<AssistantReminderRow, "completed_at" | "scheduled_at">,
  now = new Date(),
): "PENDING" | "DUE" | "COMPLETED" {
  if (row.completed_at) return "COMPLETED";
  return row.scheduled_at.getTime() <= now.getTime() ? "DUE" : "PENDING";
}

function publicReminder(row: AssistantReminderRow) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    threadArchived: row.thread_archived,
    title: row.title,
    note: row.note,
    scheduledAt: row.scheduled_at.toISOString(),
    status: reminderStatus(row),
    completedAt: row.completed_at?.toISOString() ?? null,
    notifiedAt: row.notified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function validateReminderSchedule(scheduledAt: Date, now = new Date()): void {
  const value = scheduledAt.getTime();
  if (!Number.isFinite(value) || value <= now.getTime() + 2_000) {
    throw new ApiError(400, "提醒时间至少应晚于当前时间 2 秒");
  }
  if (value > now.getTime() + MAX_REMINDER_AHEAD_MS) {
    throw new ApiError(400, "提醒时间不能超过一年");
  }
}

async function selectReminder(
  client: PoolClient,
  userId: string,
  assistantId: string,
  reminderId: string,
  lock = false,
): Promise<AssistantReminderRow> {
  const result = await client.query<AssistantReminderRow>(
    `SELECT ${REMINDER_COLUMNS}
       FROM ai_assistant_reminders reminder
       JOIN ai_assistants assistant ON assistant.id = reminder.assistant_id
       JOIN ai_assistant_threads thread ON thread.id = reminder.thread_id
      WHERE reminder.id = $1 AND reminder.assistant_id = $2
        AND reminder.owner_id = $3 AND assistant.owner_id = $3
      ${lock ? "FOR UPDATE OF reminder" : ""}`,
    [reminderId, assistantId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "提醒不存在");
  return result.rows[0];
}

async function reminderById(userId: string, assistantId: string, reminderId: string) {
  return transaction(async (client) =>
    publicReminder(await selectReminder(client, userId, assistantId, reminderId)),
  );
}

export async function listAiAssistantReminders(userId: string, assistantId: string) {
  const result = await query<AssistantReminderRow>(
    `SELECT ${REMINDER_COLUMNS}
       FROM ai_assistant_reminders reminder
       JOIN ai_assistants assistant ON assistant.id = reminder.assistant_id
       JOIN ai_assistant_threads thread ON thread.id = reminder.thread_id
      WHERE reminder.assistant_id = $1 AND reminder.owner_id = $2
        AND assistant.owner_id = $2
      ORDER BY (reminder.completed_at IS NOT NULL), reminder.scheduled_at,
               reminder.created_at DESC`,
    [assistantId, userId],
  );
  return result.rows.map(publicReminder);
}

export async function createAiAssistantReminder(
  userId: string,
  assistantId: string,
  input: SaveAiAssistantReminderInput,
) {
  validateReminderSchedule(input.scheduledAt);
  const reminderId = await transaction(async (client) => {
    const assistant = await client.query(
      `SELECT id FROM ai_assistants WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [assistantId, userId],
    );
    if (!assistant.rowCount) throw new ApiError(404, "智能助理不存在");
    await requireActiveAiAssistantThread(userId, assistantId, input.threadId, client);
    const count = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ai_assistant_reminders
        WHERE assistant_id = $1 AND owner_id = $2`,
      [assistantId, userId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_REMINDER_LIMIT) {
      throw new ApiError(400, `每个助理最多保留 ${ASSISTANT_REMINDER_LIMIT} 个提醒`);
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_reminders
         (id, assistant_id, thread_id, owner_id, title, note, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, assistantId, input.threadId, userId, input.title, input.note, input.scheduledAt],
    );
    return id;
  });
  return reminderById(userId, assistantId, reminderId);
}

export async function updateAiAssistantReminder(
  userId: string,
  assistantId: string,
  reminderId: string,
  input: UpdateAiAssistantReminderInput,
) {
  if (input.scheduledAt) validateReminderSchedule(input.scheduledAt);
  await transaction(async (client) => {
    const current = await selectReminder(client, userId, assistantId, reminderId, true);
    let completedAt = current.completed_at;
    let notifiedAt = current.notified_at;
    const scheduledAt = input.scheduledAt ?? current.scheduled_at;

    if (input.scheduledAt) {
      completedAt = null;
      notifiedAt = null;
    }
    if (input.completed === true) completedAt = new Date();
    if (input.completed === false) {
      validateReminderSchedule(scheduledAt);
      completedAt = null;
      notifiedAt = null;
    }

    await client.query(
      `UPDATE ai_assistant_reminders
          SET title = $4, note = $5, scheduled_at = $6,
              completed_at = $7, notified_at = $8, updated_at = NOW()
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3`,
      [
        reminderId,
        assistantId,
        userId,
        input.title ?? current.title,
        input.note ?? current.note,
        scheduledAt,
        completedAt,
        notifiedAt,
      ],
    );
  });
  return reminderById(userId, assistantId, reminderId);
}

export async function deleteAiAssistantReminder(
  userId: string,
  assistantId: string,
  reminderId: string,
): Promise<void> {
  await transaction(async (client) => {
    await selectReminder(client, userId, assistantId, reminderId, true);
    await client.query(
      `DELETE FROM ai_assistant_reminders
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3`,
      [reminderId, assistantId, userId],
    );
  });
}
