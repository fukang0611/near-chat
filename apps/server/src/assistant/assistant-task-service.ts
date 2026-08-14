import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import type { AiAssistantScheduleType } from "./assistant-task-schedule.js";
import { nextAssistantTaskRun } from "./assistant-task-schedule.js";

const ASSISTANT_TASK_LIMIT = 50;
const ASSISTANT_TASK_RUN_LIMIT = 5;
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export type AiAssistantTaskStatus = "NEVER" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type AiAssistantTaskRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type AiAssistantTaskTrigger = "SCHEDULED" | "MANUAL";

export interface SaveAiAssistantTaskInput {
  title: string;
  prompt: string;
  scheduleType: AiAssistantScheduleType;
  scheduledFor: Date;
  enabled: boolean;
}

export interface UpdateAiAssistantTaskInput {
  title?: string;
  prompt?: string;
  scheduleType?: AiAssistantScheduleType;
  scheduledFor?: Date;
  enabled?: boolean;
}

interface AssistantTaskRow {
  id: string;
  assistant_id: string;
  owner_id: string;
  title: string;
  prompt: string;
  schedule_type: AiAssistantScheduleType;
  enabled: boolean;
  next_run_at: Date | null;
  run_requested_at: Date | null;
  last_run_at: Date | null;
  last_status: AiAssistantTaskStatus;
  last_error: string | null;
  run_count: number;
  created_at: Date;
  updated_at: Date;
}

interface AssistantTaskRunRow {
  id: string;
  task_id: string;
  trigger: AiAssistantTaskTrigger;
  status: AiAssistantTaskRunStatus;
  scheduled_for: Date;
  started_at: Date;
  completed_at: Date | null;
  result_message_id: string | null;
  error_message: string | null;
}

const TASK_COLUMNS = `
  task.id, task.assistant_id, task.owner_id, task.title, task.prompt,
  task.schedule_type, task.enabled, task.next_run_at, task.run_requested_at,
  task.last_run_at, task.last_status, task.last_error, task.run_count,
  task.created_at, task.updated_at`;

function publicRun(row: AssistantTaskRunRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    status: row.status,
    scheduledFor: row.scheduled_for.toISOString(),
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    resultMessageId: row.result_message_id,
    errorMessage: row.error_message,
  };
}

function publicTask(row: AssistantTaskRow, runs: AssistantTaskRunRow[] = []) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title,
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    enabled: row.enabled,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    runRequested: Boolean(row.run_requested_at),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    runCount: row.run_count,
    recentRuns: runs.map(publicRun),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function assertAssistantOwner(
  client: PoolClient,
  userId: string,
  assistantId: string,
): Promise<void> {
  const result = await client.query(`SELECT 1 FROM ai_assistants WHERE id = $1 AND owner_id = $2`, [
    assistantId,
    userId,
  ]);
  if (!result.rowCount) throw new ApiError(404, "智能助理不存在");
}

async function selectTask(
  client: PoolClient,
  userId: string,
  assistantId: string,
  taskId: string,
  lock = false,
): Promise<AssistantTaskRow> {
  const result = await client.query<AssistantTaskRow>(
    `SELECT ${TASK_COLUMNS}
       FROM ai_assistant_tasks task
      WHERE task.id = $1 AND task.assistant_id = $2 AND task.owner_id = $3
      ${lock ? "FOR UPDATE" : ""}`,
    [taskId, assistantId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "助理任务不存在");
  return result.rows[0];
}

function validateScheduledFor(scheduledFor: Date, now = new Date()): void {
  const value = scheduledFor.getTime();
  if (!Number.isFinite(value) || value <= now.getTime() + 2_000) {
    throw new ApiError(400, "首次执行时间至少应晚于当前时间 2 秒");
  }
  if (value > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
    throw new ApiError(400, "首次执行时间不能超过一年");
  }
}

async function taskWithRuns(
  userId: string,
  assistantId: string,
  taskId: string,
): Promise<ReturnType<typeof publicTask>> {
  const tasks = await listAiAssistantTasks(userId, assistantId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new ApiError(404, "助理任务不存在");
  return task;
}

export async function listAiAssistantTasks(userId: string, assistantId: string) {
  const taskResult = await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId);
    return client.query<AssistantTaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM ai_assistant_tasks task
        WHERE task.assistant_id = $1 AND task.owner_id = $2
        ORDER BY task.enabled DESC, task.next_run_at NULLS LAST,
                 task.updated_at DESC, task.created_at DESC`,
      [assistantId, userId],
    );
  });
  if (taskResult.rows.length === 0) return [];

  const taskIds = taskResult.rows.map((task) => task.id);
  const runResult = await query<AssistantTaskRunRow>(
    `SELECT history.id, history.task_id, history.trigger, history.status,
            history.scheduled_for, history.started_at, history.completed_at,
            history.result_message_id, history.error_message
       FROM (
         SELECT run.*,
                ROW_NUMBER() OVER (PARTITION BY run.task_id
                                   ORDER BY run.started_at DESC, run.id DESC) AS position
           FROM ai_assistant_task_runs run
          WHERE run.task_id = ANY($1::uuid[])
       ) history
      WHERE history.position <= $2
      ORDER BY history.started_at DESC, history.id DESC`,
    [taskIds, ASSISTANT_TASK_RUN_LIMIT],
  );
  const runsByTask = new Map<string, AssistantTaskRunRow[]>();
  for (const run of runResult.rows) {
    const runs = runsByTask.get(run.task_id) ?? [];
    runs.push(run);
    runsByTask.set(run.task_id, runs);
  }
  return taskResult.rows.map((task) => publicTask(task, runsByTask.get(task.id)));
}

export async function createAiAssistantTask(
  userId: string,
  assistantId: string,
  input: SaveAiAssistantTaskInput,
) {
  validateScheduledFor(input.scheduledFor);
  const taskId = await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId);
    const count = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM ai_assistant_tasks WHERE assistant_id = $1 AND owner_id = $2`,
      [assistantId, userId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_TASK_LIMIT) {
      throw new ApiError(400, `每个助理最多创建 ${ASSISTANT_TASK_LIMIT} 个任务`);
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_tasks
         (id, assistant_id, owner_id, title, prompt, schedule_type, enabled, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        assistantId,
        userId,
        input.title,
        input.prompt,
        input.scheduleType,
        input.enabled,
        input.scheduledFor,
      ],
    );
    return id;
  });
  return taskWithRuns(userId, assistantId, taskId);
}

export async function updateAiAssistantTask(
  userId: string,
  assistantId: string,
  taskId: string,
  input: UpdateAiAssistantTaskInput,
) {
  if (input.scheduledFor) validateScheduledFor(input.scheduledFor);
  await transaction(async (client) => {
    const current = await selectTask(client, userId, assistantId, taskId, true);
    const scheduleType = input.scheduleType ?? current.schedule_type;
    let nextRunAt = input.scheduledFor ?? current.next_run_at;
    const enabled = input.enabled ?? current.enabled;

    if (enabled && !nextRunAt) {
      throw new ApiError(400, "请先设置下一次执行时间再启用任务");
    }
    if (enabled && nextRunAt && nextRunAt.getTime() <= Date.now()) {
      if (scheduleType === "ONCE") {
        throw new ApiError(400, "一次性任务需要重新设置未来的执行时间");
      }
      nextRunAt = nextAssistantTaskRun(scheduleType, nextRunAt);
    }

    await client.query(
      `UPDATE ai_assistant_tasks
          SET title = $4, prompt = $5, schedule_type = $6, enabled = $7,
              next_run_at = $8,
              run_requested_at = CASE WHEN $7 THEN run_requested_at ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3`,
      [
        taskId,
        assistantId,
        userId,
        input.title ?? current.title,
        input.prompt ?? current.prompt,
        scheduleType,
        enabled,
        nextRunAt,
      ],
    );
  });
  return taskWithRuns(userId, assistantId, taskId);
}

export async function deleteAiAssistantTask(
  userId: string,
  assistantId: string,
  taskId: string,
): Promise<void> {
  await transaction(async (client) => {
    await selectTask(client, userId, assistantId, taskId, true);
    const running = await client.query(
      `SELECT 1 FROM ai_assistant_task_runs
        WHERE task_id = $1 AND status = 'RUNNING' LIMIT 1`,
      [taskId],
    );
    if (running.rowCount) throw new ApiError(409, "任务正在执行，完成后才能删除");
    await client.query(`DELETE FROM ai_assistant_tasks WHERE id = $1`, [taskId]);
  });
}

export async function requestAiAssistantTaskRun(
  userId: string,
  assistantId: string,
  taskId: string,
) {
  await transaction(async (client) => {
    const current = await selectTask(client, userId, assistantId, taskId, true);
    const running = await client.query(
      `SELECT 1 FROM ai_assistant_task_runs
        WHERE task_id = $1 AND status = 'RUNNING' LIMIT 1`,
      [taskId],
    );
    if (running.rowCount) throw new ApiError(409, "任务正在执行，请稍后再试");
    if (!current.run_requested_at) {
      await client.query(
        `UPDATE ai_assistant_tasks
            SET run_requested_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [taskId],
      );
    }
  });
  return taskWithRuns(userId, assistantId, taskId);
}
