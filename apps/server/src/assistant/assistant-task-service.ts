import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import { supportsKnowledgeDocument } from "../knowledge/document-extractor.js";
import {
  assertAiAssistantBrowserTaskPermission,
  normalizeAssistantBrowserUrl,
} from "./assistant-browser-service.js";
import { ASSISTANT_MESSAGE_FILE_LIMIT } from "./assistant-file-service.js";
import type { AiAssistantScheduleType } from "./assistant-task-schedule.js";
import { nextAssistantTaskRun } from "./assistant-task-schedule.js";

const ASSISTANT_TASK_LIMIT = 50;
const ASSISTANT_TASK_RUN_LIMIT = 5;
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export type AiAssistantTaskStatus = "NEVER" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type AiAssistantTaskRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type AiAssistantTaskTrigger = "SCHEDULED" | "MANUAL";
export type AiAssistantTaskBrowserAction = "NONE" | "READ" | "SCREENSHOT";

export interface SaveAiAssistantTaskInput {
  title: string;
  prompt: string;
  scheduleType: AiAssistantScheduleType;
  scheduledFor: Date;
  enabled: boolean;
  fileIds: string[];
  browserAction: AiAssistantTaskBrowserAction;
  browserUrl: string | null;
}

export interface UpdateAiAssistantTaskInput {
  title?: string;
  prompt?: string;
  scheduleType?: AiAssistantScheduleType;
  scheduledFor?: Date;
  enabled?: boolean;
  fileIds?: string[];
  browserAction?: AiAssistantTaskBrowserAction;
  browserUrl?: string | null;
}

interface AssistantTaskRow {
  id: string;
  assistant_id: string;
  owner_id: string;
  title: string;
  prompt: string;
  browser_action: AiAssistantTaskBrowserAction;
  browser_url: string | null;
  file_ids: string[];
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
  browser_run_id: string | null;
  tool_summary: Record<string, unknown>;
  error_message: string | null;
}

const TASK_COLUMNS = `
  task.id, task.assistant_id, task.owner_id, task.title, task.prompt,
  task.browser_action, task.browser_url,
  ARRAY(
    SELECT task_file.assistant_file_id
      FROM ai_assistant_task_files task_file
     WHERE task_file.task_id = task.id
     ORDER BY task_file.created_at, task_file.assistant_file_id
  ) AS file_ids,
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
    browserRunId: row.browser_run_id,
    toolSummary: row.tool_summary ?? {},
    errorMessage: row.error_message,
  };
}

function publicTask(row: AssistantTaskRow, runs: AssistantTaskRunRow[] = []) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title,
    prompt: row.prompt,
    fileIds: row.file_ids,
    browserAction: row.browser_action,
    browserUrl: row.browser_url,
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

function normalizeTaskBrowserTarget(
  action: AiAssistantTaskBrowserAction,
  rawUrl: string | null | undefined,
): string | null {
  if (action === "NONE") return null;
  if (!rawUrl?.trim()) throw new ApiError(400, "使用浏览器工具时必须填写目标页面");
  const normalized = normalizeAssistantBrowserUrl(rawUrl);
  const parsed = new URL(normalized);
  if (parsed.search || parsed.hash) {
    throw new ApiError(400, "自动任务的页面地址暂不支持查询参数或片段");
  }
  return normalized;
}

async function validateTaskFiles(
  client: PoolClient,
  userId: string,
  assistantId: string,
  fileIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(fileIds)];
  if (uniqueIds.length > ASSISTANT_MESSAGE_FILE_LIMIT) {
    throw new ApiError(400, `每个任务最多预授权 ${ASSISTANT_MESSAGE_FILE_LIMIT} 个文件`);
  }
  if (uniqueIds.length === 0) return [];
  const files = await client.query<{
    id: string;
    original_name: string;
    content_type: string;
  }>(
    `SELECT assistant_file.id, attachment.original_name, attachment.content_type
       FROM ai_assistant_files assistant_file
       JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
      WHERE assistant_file.id = ANY($1::uuid[])
        AND assistant_file.assistant_id = $2
        AND assistant_file.owner_id = $3
        AND attachment.state = 'READY'`,
    [uniqueIds, assistantId, userId],
  );
  if (files.rows.length !== uniqueIds.length) {
    throw new ApiError(400, "所选文件不存在或已从助理工作区移除");
  }
  const unsupported = files.rows.find(
    (file) => !supportsKnowledgeDocument(file.original_name, file.content_type),
  );
  if (unsupported) {
    throw new ApiError(400, `文件“${unsupported.original_name}”暂不支持自动读取`);
  }
  return uniqueIds;
}

async function replaceTaskFiles(
  client: PoolClient,
  taskId: string,
  fileIds: string[],
): Promise<void> {
  await client.query(`DELETE FROM ai_assistant_task_files WHERE task_id = $1`, [taskId]);
  if (fileIds.length === 0) return;
  await client.query(
    `INSERT INTO ai_assistant_task_files (task_id, assistant_file_id)
     SELECT $1, file_id FROM unnest($2::uuid[]) AS file_id`,
    [taskId, fileIds],
  );
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
            history.result_message_id, history.browser_run_id,
            history.tool_summary, history.error_message
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
  const browserUrl = normalizeTaskBrowserTarget(input.browserAction, input.browserUrl);
  const taskId = await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId);
    const fileIds = await validateTaskFiles(client, userId, assistantId, input.fileIds);
    if (input.browserAction !== "NONE") {
      await assertAiAssistantBrowserTaskPermission(
        userId,
        assistantId,
        input.browserAction,
        client,
      );
    }
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
         (id, assistant_id, owner_id, title, prompt, browser_action, browser_url,
          schedule_type, enabled, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        assistantId,
        userId,
        input.title,
        input.prompt,
        input.browserAction,
        browserUrl,
        input.scheduleType,
        input.enabled,
        input.scheduledFor,
      ],
    );
    await replaceTaskFiles(client, id, fileIds);
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
    const browserAction = input.browserAction ?? current.browser_action;
    const browserUrl = normalizeTaskBrowserTarget(
      browserAction,
      input.browserUrl === undefined ? current.browser_url : input.browserUrl,
    );
    let nextRunAt = input.scheduledFor ?? current.next_run_at;
    const enabled = input.enabled ?? current.enabled;
    const fileIds =
      input.fileIds === undefined
        ? null
        : await validateTaskFiles(client, userId, assistantId, input.fileIds);

    if (
      browserAction !== "NONE" &&
      (input.browserAction !== undefined ||
        input.browserUrl !== undefined ||
        (input.enabled === true && !current.enabled))
    ) {
      await assertAiAssistantBrowserTaskPermission(userId, assistantId, browserAction, client);
    }

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
          SET title = $4, prompt = $5, browser_action = $6, browser_url = $7,
              schedule_type = $8, enabled = $9, next_run_at = $10,
              run_requested_at = CASE WHEN $9 THEN run_requested_at ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1 AND assistant_id = $2 AND owner_id = $3`,
      [
        taskId,
        assistantId,
        userId,
        input.title ?? current.title,
        input.prompt ?? current.prompt,
        browserAction,
        browserUrl,
        scheduleType,
        enabled,
        nextRunAt,
      ],
    );
    if (fileIds) await replaceTaskFiles(client, taskId, fileIds);
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
