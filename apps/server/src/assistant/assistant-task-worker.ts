import { randomUUID } from "node:crypto";
import { getAiCapabilities } from "../ai/ai-runtime.js";
import { config } from "../config.js";
import { transaction } from "../database.js";
import type { RealtimeHub } from "../realtime.js";
import { executeAiAssistantTask } from "./assistant-service.js";
import { nextAssistantTaskRun, type AiAssistantScheduleType } from "./assistant-task-schedule.js";
import type { AiAssistantTaskTrigger } from "./assistant-task-service.js";

interface ClaimedAssistantTask {
  runId: string;
  taskId: string;
  assistantId: string;
  assistantName: string;
  ownerId: string;
  title: string;
  prompt: string;
}

interface DueTaskRow {
  id: string;
  assistant_id: string;
  assistant_name: string;
  owner_id: string;
  title: string;
  prompt: string;
  schedule_type: AiAssistantScheduleType;
  next_run_at: Date | null;
  run_requested_at: Date | null;
}

async function recoverStaleRuns(): Promise<void> {
  await transaction(async (client) => {
    const stale = await client.query<{ task_id: string }>(
      `UPDATE ai_assistant_task_runs
          SET status = 'FAILED', completed_at = NOW(),
              error_message = '服务重启或执行超时，任务已终止'
        WHERE status = 'RUNNING' AND started_at < NOW() - INTERVAL '15 minutes'
        RETURNING task_id`,
    );
    if (stale.rows.length === 0) return;
    await client.query(
      `UPDATE ai_assistant_tasks
          SET last_status = 'FAILED', last_error = '服务重启或执行超时，任务已终止',
              updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND last_status = 'RUNNING'`,
      [[...new Set(stale.rows.map((run) => run.task_id))]],
    );
  });
}

async function claimAssistantTask(): Promise<ClaimedAssistantTask | null> {
  return transaction(async (client) => {
    const result = await client.query<DueTaskRow>(
      `SELECT task.id, task.assistant_id, assistant.name AS assistant_name,
              task.owner_id, task.title, task.prompt, task.schedule_type,
              task.next_run_at, task.run_requested_at
         FROM ai_assistant_tasks task
         JOIN ai_assistants assistant ON assistant.id = task.assistant_id
        WHERE (
                task.run_requested_at IS NOT NULL
                OR (task.enabled = TRUE AND task.next_run_at <= NOW())
              )
          AND NOT EXISTS (
                SELECT 1 FROM ai_assistant_task_runs run
                 WHERE run.task_id = task.id AND run.status = 'RUNNING'
              )
        ORDER BY (task.run_requested_at IS NOT NULL) DESC,
                 COALESCE(task.run_requested_at, task.next_run_at), task.created_at
        LIMIT 1
        FOR UPDATE OF task SKIP LOCKED`,
    );
    const task = result.rows[0];
    if (!task) return null;

    const trigger: AiAssistantTaskTrigger = task.run_requested_at ? "MANUAL" : "SCHEDULED";
    const scheduledFor = task.run_requested_at ?? task.next_run_at;
    if (!scheduledFor) return null;
    const nextRunAt =
      trigger === "SCHEDULED"
        ? nextAssistantTaskRun(task.schedule_type, scheduledFor, new Date())
        : task.next_run_at;
    const runId = randomUUID();

    await client.query(
      `INSERT INTO ai_assistant_task_runs
         (id, task_id, trigger, status, scheduled_for)
       VALUES ($1, $2, $3, 'RUNNING', $4)`,
      [runId, task.id, trigger, scheduledFor],
    );
    await client.query(
      `UPDATE ai_assistant_tasks
          SET enabled = CASE
                WHEN $2 = 'SCHEDULED' AND $3::timestamptz IS NULL THEN FALSE
                ELSE enabled
              END,
              next_run_at = CASE WHEN $2 = 'SCHEDULED' THEN $3 ELSE next_run_at END,
              run_requested_at = CASE WHEN $2 = 'MANUAL' THEN NULL ELSE run_requested_at END,
              last_run_at = NOW(), last_status = 'RUNNING', last_error = NULL,
              run_count = run_count + 1, updated_at = NOW()
        WHERE id = $1`,
      [task.id, trigger, nextRunAt],
    );

    return {
      runId,
      taskId: task.id,
      assistantId: task.assistant_id,
      assistantName: task.assistant_name,
      ownerId: task.owner_id,
      title: task.title,
      prompt: task.prompt,
    };
  });
}

async function finishAssistantTask(
  task: ClaimedAssistantTask,
  result: { messageId: string } | { error: string },
): Promise<boolean> {
  return transaction(async (client) => {
    const run = await client.query(
      `UPDATE ai_assistant_task_runs
          SET status = $2, completed_at = NOW(), result_message_id = $3,
              error_message = $4
        WHERE id = $1 AND status = 'RUNNING'
        RETURNING task_id`,
      [
        task.runId,
        "error" in result ? "FAILED" : "SUCCEEDED",
        "error" in result ? null : result.messageId,
        "error" in result ? result.error : null,
      ],
    );
    if (!run.rowCount) return false;
    const updated = await client.query(
      `UPDATE ai_assistant_tasks
          SET last_status = $2, last_error = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [
        task.taskId,
        "error" in result ? "FAILED" : "SUCCEEDED",
        "error" in result ? result.error : null,
      ],
    );
    return Boolean(updated.rowCount);
  });
}

async function processAssistantTask(task: ClaimedAssistantTask, realtime: RealtimeHub) {
  try {
    const generated = await executeAiAssistantTask(
      task.ownerId,
      task.assistantId,
      task.title,
      task.prompt,
    );
    const reply = generated.messages.find((message) => message.role === "ASSISTANT");
    if (!reply) throw new Error("模型没有生成任务结果");
    const preview = reply.content.trim().slice(0, 180);
    if (!(await finishAssistantTask(task, { messageId: reply.id }))) return;
    realtime.sendToUsers([task.ownerId], {
      type: "assistant.task.completed",
      payload: {
        taskId: task.taskId,
        assistantId: task.assistantId,
        assistantName: generated.assistantName,
        taskTitle: task.title,
        status: "SUCCEEDED",
        messageId: reply.id,
        preview,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "助理任务执行失败").slice(0, 500);
    if (!(await finishAssistantTask(task, { error: message }))) return;
    realtime.sendToUsers([task.ownerId], {
      type: "assistant.task.completed",
      payload: {
        taskId: task.taskId,
        assistantId: task.assistantId,
        assistantName: task.assistantName,
        taskTitle: task.title,
        status: "FAILED",
        messageId: null,
        preview: message,
        createdAt: new Date().toISOString(),
      },
    });
    console.error(`Assistant task ${task.taskId} failed:`, error);
  }
}

/** PostgreSQL 持久调度器：多副本通过 SKIP LOCKED 互斥，AI 未就绪时保持任务原状。 */
export function startAssistantTaskWorker(realtime: RealtimeHub): () => void {
  let running = false;
  let stopped = false;
  let lastRecoveryAt = 0;
  const run = async () => {
    if (running || stopped || !getAiCapabilities().features.personalAssistants) return;
    running = true;
    try {
      if (Date.now() - lastRecoveryAt > 60_000) {
        await recoverStaleRuns();
        lastRecoveryAt = Date.now();
      }
      // 每轮限制数量，避免积压任务长期占用 Node 事件循环。
      for (let count = 0; count < 5 && !stopped; count += 1) {
        const task = await claimAssistantTask();
        if (!task) break;
        await processAssistantTask(task, realtime);
      }
    } catch (error) {
      console.error("Assistant task worker cycle failed:", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, config.ai.assistantTasks.pollMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
