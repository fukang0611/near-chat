import { query, transaction } from "../database.js";
import type { RealtimeHub } from "../realtime.js";

interface DueReminderRow {
  id: string;
  assistant_id: string;
  thread_id: string;
  owner_id: string;
  assistant_name: string;
  title: string;
  note: string;
  scheduled_at: Date;
}

async function claimDueReminders(onlineUserIds: string[]): Promise<DueReminderRow[]> {
  if (onlineUserIds.length === 0) return [];
  return transaction(async (client) => {
    const candidates = await client.query<DueReminderRow>(
      `SELECT reminder.id, reminder.assistant_id, reminder.thread_id,
              reminder.owner_id, assistant.name AS assistant_name,
              reminder.title, reminder.note, reminder.scheduled_at
         FROM ai_assistant_reminders reminder
         JOIN ai_assistants assistant ON assistant.id = reminder.assistant_id
         JOIN ai_assistant_threads thread ON thread.id = reminder.thread_id
        WHERE reminder.owner_id = ANY($1::uuid[])
          AND reminder.completed_at IS NULL
          AND reminder.notified_at IS NULL
          AND reminder.scheduled_at <= NOW()
          AND thread.archived = FALSE
        ORDER BY reminder.scheduled_at, reminder.created_at
        LIMIT 20
        FOR UPDATE OF reminder SKIP LOCKED`,
      [onlineUserIds],
    );
    if (candidates.rows.length === 0) return [];
    await client.query(
      `UPDATE ai_assistant_reminders
          SET notified_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND notified_at IS NULL`,
      [candidates.rows.map((reminder) => reminder.id)],
    );
    return candidates.rows;
  });
}

async function deliverDueReminders(realtime: RealtimeHub): Promise<void> {
  const reminders = await claimDueReminders(realtime.onlineUserIds());
  for (const reminder of reminders) {
    const delivered = realtime.sendToUsers([reminder.owner_id], {
      type: "assistant.reminder.due",
      payload: {
        reminderId: reminder.id,
        assistantId: reminder.assistant_id,
        threadId: reminder.thread_id,
        assistantName: reminder.assistant_name,
        title: reminder.title,
        note: reminder.note,
        scheduledAt: reminder.scheduled_at.toISOString(),
        createdAt: new Date().toISOString(),
      },
    });
    if (delivered.length === 0) {
      // 认领与发送之间连接可能关闭；清除标记后，下次上线仍能收到提醒。
      await query(
        `UPDATE ai_assistant_reminders
            SET notified_at = NULL, updated_at = NOW()
          WHERE id = $1 AND completed_at IS NULL`,
        [reminder.id],
      );
    }
  }
}

/** 提醒不调用模型，独立于 AI 任务执行队列；多副本使用行锁避免重复到期事件。 */
export function startAssistantReminderWorker(realtime: RealtimeHub): () => void {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await deliverDueReminders(realtime);
    } catch (error) {
      console.error("Assistant reminder worker cycle failed:", error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
