import { randomUUID } from "node:crypto";
import {
  type PersonalEntityType,
  resolveCompletedAt,
  type SyncChange,
  type SyncOperation,
  type PersonalRecord,
  type PersonalReminder,
  type PersonalTask,
} from "@near-chat/domain";
import type { PoolClient } from "pg";
import { query, transaction } from "./database.js";
import { ApiError } from "./http.js";
import { lockOwnerSyncStream, recordSyncSnapshot } from "./sync-projection.js";
import { z } from "zod";

const syncTimestamp = z.string().datetime({ offset: true });
const syncTaskPayload = z.object({
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(4000).default(""),
  dueAt: syncTimestamp.nullable().default(null),
  completedAt: syncTimestamp.nullable().default(null),
});
const syncReminderPayload = z.object({
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(4000).default(""),
  scheduledAt: syncTimestamp,
  completedAt: syncTimestamp.nullable().default(null),
  notifiedAt: syncTimestamp.nullable().default(null),
});
const syncRecordPayload = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1, "个人记录内容不能为空").max(20000),
});

export type PersonalTaskSyncPayload = z.infer<typeof syncTaskPayload>;
export type PersonalReminderSyncPayload = z.infer<typeof syncReminderPayload>;
export type PersonalRecordSyncPayload = z.infer<typeof syncRecordPayload>;
export type ParsedPersonalSyncPayload =
  PersonalTaskSyncPayload | PersonalReminderSyncPayload | PersonalRecordSyncPayload;

/** 丢弃 id、ownerId、revision 和时间戳等服务端权威字段。 */
export function parsePersonalSyncPayload(
  entityType: "PERSONAL_TASK",
  payload: Record<string, unknown>,
): PersonalTaskSyncPayload;
export function parsePersonalSyncPayload(
  entityType: "PERSONAL_REMINDER",
  payload: Record<string, unknown>,
): PersonalReminderSyncPayload;
export function parsePersonalSyncPayload(
  entityType: "PERSONAL_RECORD",
  payload: Record<string, unknown>,
): PersonalRecordSyncPayload;
export function parsePersonalSyncPayload(
  entityType: PersonalEntityType,
  payload: Record<string, unknown>,
): ParsedPersonalSyncPayload {
  switch (entityType) {
    case "PERSONAL_TASK":
      return syncTaskPayload.parse(payload);
    case "PERSONAL_REMINDER":
      return syncReminderPayload.parse(payload);
    case "PERSONAL_RECORD":
      return syncRecordPayload.parse(payload);
  }
}

interface TaskRow {
  id: string;
  title: string;
  note: string;
  due_at: Date | null;
  completed_at: Date | null;
  revision: number;
  deleted_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface ReminderRow {
  id: string;
  title: string;
  note: string;
  scheduled_at: Date;
  completed_at: Date | null;
  notified_at: Date | null;
  revision: number;
  deleted_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface RecordRow {
  id: string;
  title: string;
  content: string;
  revision: number;
  deleted_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

const task = (row: TaskRow): PersonalTask => ({
  id: row.id,
  title: row.title,
  note: row.note,
  dueAt: row.due_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const reminder = (row: ReminderRow): PersonalReminder => ({
  id: row.id,
  title: row.title,
  note: row.note,
  scheduledAt: row.scheduled_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null,
  notifiedAt: row.notified_at?.toISOString() ?? null,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const record = (row: RecordRow): PersonalRecord => ({
  id: row.id,
  title: row.title,
  content: row.content,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export interface PersonalSyncState {
  revision: number;
  deleted: boolean;
  completedAt?: string | null;
  payload: Record<string, unknown>;
  updatedAt: string;
}

function taskSyncState(row: TaskRow): PersonalSyncState {
  const payload = task(row);
  return {
    revision: row.revision,
    deleted: Boolean(row.deleted_at),
    completedAt: payload.completedAt,
    payload: row.deleted_at
      ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at.toISOString() }
      : { ...payload },
    updatedAt: row.updated_at.toISOString(),
  };
}

function reminderSyncState(row: ReminderRow): PersonalSyncState {
  const payload = reminder(row);
  return {
    revision: row.revision,
    deleted: Boolean(row.deleted_at),
    completedAt: payload.completedAt,
    payload: row.deleted_at
      ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at.toISOString() }
      : { ...payload },
    updatedAt: row.updated_at.toISOString(),
  };
}

function recordSyncState(row: RecordRow): PersonalSyncState {
  const payload = record(row);
  return {
    revision: row.revision,
    deleted: Boolean(row.deleted_at),
    payload: row.deleted_at
      ? { id: row.id, revision: row.revision, deletedAt: row.deleted_at.toISOString() }
      : { ...payload },
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 锁定真实个人业务行；同步冲突判断不能再以 JSON 快照作为事实来源。 */
export async function loadPersonalSyncState(
  client: PoolClient,
  ownerId: string,
  entityType: PersonalEntityType,
  entityId: string,
): Promise<PersonalSyncState | null> {
  switch (entityType) {
    case "PERSONAL_TASK": {
      const result = await client.query<TaskRow>(
        `SELECT id,title,note,due_at,completed_at,revision,deleted_at,created_at,updated_at
           FROM personal_tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [entityId, ownerId],
      );
      return result.rows[0] ? taskSyncState(result.rows[0]) : null;
    }
    case "PERSONAL_REMINDER": {
      const result = await client.query<ReminderRow>(
        `SELECT id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at
           FROM personal_reminders WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [entityId, ownerId],
      );
      return result.rows[0] ? reminderSyncState(result.rows[0]) : null;
    }
    case "PERSONAL_RECORD": {
      const result = await client.query<RecordRow>(
        `SELECT id,title,content,revision,deleted_at,created_at,updated_at
           FROM personal_records WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
        [entityId, ownerId],
      );
      return result.rows[0] ? recordSyncState(result.rows[0]) : null;
    }
  }
}

export async function applyPersonalSyncOperation(
  client: PoolClient,
  ownerId: string,
  operation: SyncOperation & { entityType: PersonalEntityType },
  revision: number,
): Promise<SyncChange> {
  let state: PersonalSyncState;
  if (operation.operation === "DELETE") {
    const table = {
      PERSONAL_TASK: "personal_tasks",
      PERSONAL_REMINDER: "personal_reminders",
      PERSONAL_RECORD: "personal_records",
    }[operation.entityType];
    const result = await client.query<{ id: string; deleted_at: Date }>(
      `UPDATE ${table}
          SET deleted_at=NOW(), revision=$3, updated_at=NOW()
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
        RETURNING id, deleted_at`,
      [operation.entityId, ownerId, revision],
    );
    const deletedAt = result.rows[0]?.deleted_at;
    if (!deletedAt) throw new ApiError(409, "个人实体已被其他设备更新");
    state = {
      revision,
      deleted: true,
      payload: { id: operation.entityId, revision, deletedAt: deletedAt.toISOString() },
      updatedAt: deletedAt.toISOString(),
    };
  } else {
    switch (operation.entityType) {
      case "PERSONAL_TASK": {
        const payload = parsePersonalSyncPayload("PERSONAL_TASK", operation.payload);
        const result = await client.query<TaskRow>(
          operation.baseRevision === null
            ? `INSERT INTO personal_tasks
                 (id,owner_id,title,note,due_at,completed_at,revision)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               RETURNING id,title,note,due_at,completed_at,revision,deleted_at,created_at,updated_at`
            : `UPDATE personal_tasks
                  SET title=$3,note=$4,due_at=$5,
                      completed_at=COALESCE(completed_at,$6),revision=$7,updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
                RETURNING id,title,note,due_at,completed_at,revision,deleted_at,created_at,updated_at`,
          [
            operation.entityId,
            ownerId,
            payload.title,
            payload.note,
            payload.dueAt,
            payload.completedAt,
            revision,
          ],
        );
        if (!result.rows[0]) throw new ApiError(409, "个人任务已被其他设备更新");
        state = taskSyncState(result.rows[0]);
        break;
      }
      case "PERSONAL_REMINDER": {
        const payload = parsePersonalSyncPayload("PERSONAL_REMINDER", operation.payload);
        const result = await client.query<ReminderRow>(
          operation.baseRevision === null
            ? `INSERT INTO personal_reminders
                 (id,owner_id,title,note,scheduled_at,completed_at,notified_at,revision)
               VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)
               RETURNING id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at`
            : `UPDATE personal_reminders
                  SET title=$3,note=$4,scheduled_at=$5,
                      completed_at=COALESCE(completed_at,$6),
                      notified_at=CASE
                        WHEN scheduled_at IS DISTINCT FROM $5::timestamptz THEN NULL
                        ELSE notified_at
                      END,
                      revision=$7,updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
                RETURNING id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at`,
          [
            operation.entityId,
            ownerId,
            payload.title,
            payload.note,
            payload.scheduledAt,
            payload.completedAt,
            revision,
          ],
        );
        if (!result.rows[0]) throw new ApiError(409, "个人提醒已被其他设备更新");
        state = reminderSyncState(result.rows[0]);
        break;
      }
      case "PERSONAL_RECORD": {
        const payload = parsePersonalSyncPayload("PERSONAL_RECORD", operation.payload);
        const result = await client.query<RecordRow>(
          operation.baseRevision === null
            ? `INSERT INTO personal_records (id,owner_id,title,content,revision)
               VALUES ($1,$2,$3,$4,$5)
               RETURNING id,title,content,revision,deleted_at,created_at,updated_at`
            : `UPDATE personal_records
                  SET title=$3,content=$4,revision=$5,updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
                RETURNING id,title,content,revision,deleted_at,created_at,updated_at`,
          [operation.entityId, ownerId, payload.title, payload.content, revision],
        );
        if (!result.rows[0]) throw new ApiError(409, "个人记录已被其他设备更新");
        state = recordSyncState(result.rows[0]);
        break;
      }
    }
  }
  const change = await recordSyncSnapshot(
    client,
    ownerId,
    operation.entityType,
    operation.entityId,
    state.revision,
    state.payload,
    state.deleted,
  );
  if (!change) throw new ApiError(409, "同步操作没有产生新的业务版本");
  return change;
}

export async function listPersonalTasks(ownerId: string) {
  return (
    await query<TaskRow>(
      `SELECT id,title,note,due_at,completed_at,revision,created_at,updated_at FROM personal_tasks WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY completed_at NULLS FIRST, due_at NULLS LAST, updated_at DESC`,
      [ownerId],
    )
  ).rows.map(task);
}
export async function listPersonalReminders(ownerId: string) {
  return (
    await query<ReminderRow>(
      `SELECT id,title,note,scheduled_at,completed_at,notified_at,revision,created_at,updated_at FROM personal_reminders WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY completed_at NULLS FIRST, scheduled_at`,
      [ownerId],
    )
  ).rows.map(reminder);
}
export async function listPersonalRecords(ownerId: string) {
  return (
    await query<RecordRow>(
      `SELECT id,title,content,revision,created_at,updated_at FROM personal_records WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [ownerId],
    )
  ).rows.map(record);
}

export async function createPersonalTask(
  ownerId: string,
  input: { title: string; note: string; dueAt: Date | null },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const id = randomUUID();
    const result = await client.query<TaskRow>(
      `INSERT INTO personal_tasks (id,owner_id,title,note,due_at) VALUES ($1,$2,$3,$4,$5) RETURNING id,title,note,due_at,completed_at,revision,created_at,updated_at`,
      [id, ownerId, input.title, input.note, input.dueAt],
    );
    const value = task(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_TASK", id, value.revision, { ...value });
    return value;
  });
}
export async function updatePersonalTask(
  ownerId: string,
  id: string,
  input: Partial<{ title: string; note: string; dueAt: Date | null; completed: boolean }> & {
    baseRevision: number;
  },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const found = await client.query<TaskRow & { owner_id: string }>(
      `SELECT id,owner_id,title,note,due_at,completed_at,revision,created_at,updated_at FROM personal_tasks WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [id, ownerId],
    );
    const current = found.rows[0];
    if (!current) throw new ApiError(404, "个人任务不存在");
    if (current.revision !== input.baseRevision)
      throw new ApiError(409, "任务已在其他设备更新，请同步后再修改");
    const completedAt =
      input.completed === undefined
        ? current.completed_at
        : resolveCompletedAt(
            current.completed_at?.toISOString() ?? null,
            input.completed ? new Date().toISOString() : null,
          );
    const result = await client.query<TaskRow>(
      `UPDATE personal_tasks SET title=$3,note=$4,due_at=$5,completed_at=$6,revision=revision+1,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING id,title,note,due_at,completed_at,revision,created_at,updated_at`,
      [
        id,
        ownerId,
        input.title ?? current.title,
        input.note ?? current.note,
        input.dueAt === undefined ? current.due_at : input.dueAt,
        completedAt,
      ],
    );
    const value = task(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_TASK", id, value.revision, { ...value });
    return value;
  });
}
export async function deletePersonalTask(ownerId: string, id: string, baseRevision: number) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const result = await client.query<TaskRow>(
      `UPDATE personal_tasks SET deleted_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND revision=$3 RETURNING id,title,note,due_at,completed_at,revision,deleted_at,created_at,updated_at`,
      [id, ownerId, baseRevision],
    );
    if (!result.rows[0]) throw new ApiError(409, "任务不存在或已在其他设备更新");
    const row = result.rows[0];
    const deletedAt = row.deleted_at ?? row.updated_at;
    await recordSyncSnapshot(
      client,
      ownerId,
      "PERSONAL_TASK",
      id,
      row.revision,
      { id, revision: row.revision, deletedAt: deletedAt.toISOString() },
      true,
    );
  });
}

export async function createPersonalReminder(
  ownerId: string,
  input: { title: string; note: string; scheduledAt: Date },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const id = randomUUID();
    const result = await client.query<ReminderRow>(
      `INSERT INTO personal_reminders (id,owner_id,title,note,scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING id,title,note,scheduled_at,completed_at,notified_at,revision,created_at,updated_at`,
      [id, ownerId, input.title, input.note, input.scheduledAt],
    );
    const value = reminder(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_REMINDER", id, value.revision, {
      ...value,
    });
    return value;
  });
}

export async function updatePersonalReminder(
  ownerId: string,
  id: string,
  input: Partial<{
    title: string;
    note: string;
    scheduledAt: Date;
    completed: boolean;
    notifiedAt: Date | null;
  }> & { baseRevision: number },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const found = await client.query<ReminderRow>(
      `SELECT id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at
         FROM personal_reminders
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [id, ownerId],
    );
    const current = found.rows[0];
    if (!current) throw new ApiError(404, "个人提醒不存在");
    if (current.revision !== input.baseRevision)
      throw new ApiError(409, "提醒已在其他设备更新，请同步后再修改");
    const completedAt =
      input.completed === undefined
        ? current.completed_at
        : resolveCompletedAt(
            current.completed_at?.toISOString() ?? null,
            input.completed ? new Date().toISOString() : null,
          );
    const result = await client.query<ReminderRow>(
      `UPDATE personal_reminders
          SET title=$3,note=$4,scheduled_at=$5,completed_at=$6,
              notified_at=$7,revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND owner_id=$2
        RETURNING id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at`,
      [
        id,
        ownerId,
        input.title ?? current.title,
        input.note ?? current.note,
        input.scheduledAt ?? current.scheduled_at,
        completedAt,
        input.notifiedAt !== undefined
          ? input.notifiedAt
          : input.scheduledAt !== undefined
            ? null
            : current.notified_at,
      ],
    );
    const value = reminder(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_REMINDER", id, value.revision, {
      ...value,
    });
    return value;
  });
}

export async function deletePersonalReminder(ownerId: string, id: string, baseRevision: number) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const result = await client.query<ReminderRow>(
      `UPDATE personal_reminders
          SET deleted_at=NOW(),revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND revision=$3
        RETURNING id,title,note,scheduled_at,completed_at,notified_at,revision,deleted_at,created_at,updated_at`,
      [id, ownerId, baseRevision],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(409, "提醒不存在或已在其他设备更新");
    const deletedAt = row.deleted_at ?? row.updated_at;
    await recordSyncSnapshot(
      client,
      ownerId,
      "PERSONAL_REMINDER",
      id,
      row.revision,
      { id, revision: row.revision, deletedAt: deletedAt.toISOString() },
      true,
    );
  });
}

export async function createPersonalRecord(
  ownerId: string,
  input: { title: string; content: string },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const id = randomUUID();
    const result = await client.query<RecordRow>(
      `INSERT INTO personal_records (id,owner_id,title,content) VALUES ($1,$2,$3,$4) RETURNING id,title,content,revision,created_at,updated_at`,
      [id, ownerId, input.title, input.content],
    );
    const value = record(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_RECORD", id, value.revision, { ...value });
    return value;
  });
}

export async function updatePersonalRecord(
  ownerId: string,
  id: string,
  input: Partial<{ title: string; content: string }> & { baseRevision: number },
) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const found = await client.query<RecordRow>(
      `SELECT id,title,content,revision,deleted_at,created_at,updated_at
         FROM personal_records
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [id, ownerId],
    );
    const current = found.rows[0];
    if (!current) throw new ApiError(404, "个人记录不存在");
    if (current.revision !== input.baseRevision)
      throw new ApiError(409, "记录已在其他设备更新，请同步后再修改");
    const result = await client.query<RecordRow>(
      `UPDATE personal_records
          SET title=$3,content=$4,revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND owner_id=$2
        RETURNING id,title,content,revision,deleted_at,created_at,updated_at`,
      [id, ownerId, input.title ?? current.title, input.content ?? current.content],
    );
    const value = record(result.rows[0]!);
    await recordSyncSnapshot(client, ownerId, "PERSONAL_RECORD", id, value.revision, { ...value });
    return value;
  });
}

export async function deletePersonalRecord(ownerId: string, id: string, baseRevision: number) {
  return transaction(async (client) => {
    await lockOwnerSyncStream(client, ownerId);
    const result = await client.query<RecordRow>(
      `UPDATE personal_records
          SET deleted_at=NOW(),revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND revision=$3
        RETURNING id,title,content,revision,deleted_at,created_at,updated_at`,
      [id, ownerId, baseRevision],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(409, "记录不存在或已在其他设备更新");
    const deletedAt = row.deleted_at ?? row.updated_at;
    await recordSyncSnapshot(
      client,
      ownerId,
      "PERSONAL_RECORD",
      id,
      row.revision,
      { id, revision: row.revision, deletedAt: deletedAt.toISOString() },
      true,
    );
  });
}
