import { query, transaction } from "../database.js";
import { queueBoundConnectorDeliveriesWithClient } from "../connectors/connector-service.js";
import type { PoolClient } from "pg";
import type { RealtimeHub } from "../realtime.js";
import { lockOwnerSyncStreams, recordSyncSnapshot } from "../sync-projection.js";

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

interface DuePersonalReminderRow {
  id: string;
  owner_id: string;
  title: string;
  note: string;
  scheduled_at: Date;
  completed_at: Date | null;
  notified_at: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function personalReminderPayload(reminder: DuePersonalReminderRow): Record<string, unknown> {
  return {
    id: reminder.id,
    title: reminder.title,
    note: reminder.note,
    scheduledAt: reminder.scheduled_at.toISOString(),
    completedAt: reminder.completed_at?.toISOString() ?? null,
    notifiedAt: reminder.notified_at?.toISOString() ?? null,
    revision: reminder.revision,
    createdAt: reminder.created_at.toISOString(),
    updatedAt: reminder.updated_at.toISOString(),
  };
}

/**
 * 通用个人提醒是手机和多端同步共同使用的权威实体。认领、connector outbox、
 * notifiedAt/revision 与同步增量必须在同一事务内提交，避免“已通知但没有投递任务”
 * 或“已投递但其他设备仍显示未通知”的分裂状态。
 */
export async function queueDuePersonalReminderDeliveries(): Promise<void> {
  await transaction(queueDuePersonalReminderDeliveriesWithClient);
}

export async function queueDuePersonalReminderDeliveriesWithClient(
  client: PoolClient,
): Promise<void> {
  const dueOwners = await client.query<{ owner_id: string }>(
    `SELECT DISTINCT candidate.owner_id
       FROM (
         SELECT reminder.owner_id
           FROM personal_reminders reminder
          WHERE reminder.completed_at IS NULL AND reminder.notified_at IS NULL
            AND reminder.deleted_at IS NULL AND reminder.scheduled_at<=NOW()
            AND EXISTS (
                  SELECT 1
                    FROM connector_bindings binding
                    JOIN connector_configs config ON config.id=binding.connector_id
                   WHERE binding.owner_id=reminder.owner_id
                     AND binding.enabled=TRUE AND config.enabled=TRUE
                     AND 'REMINDER'=ANY(binding.delivery_kinds)
                )
          ORDER BY reminder.scheduled_at,reminder.created_at
          LIMIT 100
       ) candidate
      ORDER BY candidate.owner_id`,
  );
  const ownerIds = dueOwners.rows.map((row) => row.owner_id);
  if (ownerIds.length === 0) return;
  // 候选读取不锁业务行；固定 owner 锁拿到后，下面只认领这些 owner 的提醒。
  await lockOwnerSyncStreams(client, ownerIds);
  const reminders = await client.query<DuePersonalReminderRow>(
    `SELECT reminder.id,reminder.owner_id,reminder.title,reminder.note,
              reminder.scheduled_at,reminder.completed_at,reminder.notified_at,
              reminder.revision,reminder.created_at,reminder.updated_at
         FROM personal_reminders reminder
        WHERE reminder.completed_at IS NULL AND reminder.notified_at IS NULL
          AND reminder.deleted_at IS NULL AND reminder.scheduled_at<=NOW()
          AND reminder.owner_id=ANY($1::uuid[])
          AND EXISTS (
                SELECT 1
                  FROM connector_bindings binding
                  JOIN connector_configs config ON config.id=binding.connector_id
                 WHERE binding.owner_id=reminder.owner_id
                   AND binding.enabled=TRUE AND config.enabled=TRUE
                   AND 'REMINDER'=ANY(binding.delivery_kinds)
              )
        ORDER BY reminder.scheduled_at,reminder.created_at
        LIMIT 100
        FOR UPDATE OF reminder SKIP LOCKED`,
    [ownerIds],
  );
  for (const reminder of reminders.rows) {
    const summary = [`提醒：${reminder.title}`, reminder.note.trim() ? reminder.note.trim() : null]
      .filter(Boolean)
      .join("\n");
    const jobs = await queueBoundConnectorDeliveriesWithClient(client, {
      ownerId: reminder.owner_id,
      kind: "REMINDER",
      sourceId: reminder.id,
      payload: {
        text: summary,
        summary,
        status: "DUE",
        source: "PERSONAL_REMINDER",
        reminderId: reminder.id,
        scheduledAt: reminder.scheduled_at.toISOString(),
      },
    });
    if (jobs.length === 0) continue;
    const updated = await client.query<DuePersonalReminderRow>(
      `UPDATE personal_reminders
          SET notified_at=NOW(),revision=revision+1,updated_at=NOW()
        WHERE id=$1 AND notified_at IS NULL AND completed_at IS NULL AND deleted_at IS NULL
      RETURNING id,owner_id,title,note,scheduled_at,completed_at,notified_at,
                revision,created_at,updated_at`,
      [reminder.id],
    );
    const row = updated.rows[0];
    if (!row) throw new Error("个人提醒在 connector outbox 入队期间失去认领状态");
    await recordSyncSnapshot(
      client,
      row.owner_id,
      "PERSONAL_REMINDER",
      row.id,
      row.revision,
      personalReminderPayload(row),
    );
  }
}

/**
 * 外部提醒不依赖 WebSocket 在线状态。到期事实与 connector outbox 在同一数据库事务中
 * 读取/写入，稳定 reminderId + bindingId 保证多副本和轮询重入不会重复建单。
 */
export async function queueDueExternalReminders(): Promise<void> {
  await transaction(async (client) => {
    const reminders = await client.query<DueReminderRow>(
      `SELECT reminder.id,reminder.assistant_id,reminder.thread_id,reminder.owner_id,
              assistant.name AS assistant_name,reminder.title,reminder.note,reminder.scheduled_at
         FROM ai_assistant_reminders reminder
         JOIN ai_assistants assistant ON assistant.id=reminder.assistant_id
         JOIN ai_assistant_threads thread ON thread.id=reminder.thread_id
        WHERE reminder.completed_at IS NULL AND reminder.scheduled_at<=NOW()
          AND thread.archived=FALSE
          AND assistant.deleted_at IS NULL AND thread.deleted_at IS NULL
          AND EXISTS (
                SELECT 1
                  FROM connector_bindings binding
                  JOIN connector_configs config ON config.id=binding.connector_id
                 WHERE binding.owner_id=reminder.owner_id
                   AND binding.enabled=TRUE AND config.enabled=TRUE
                   AND 'REMINDER'=ANY(binding.delivery_kinds)
                   AND NOT EXISTS (
                         SELECT 1 FROM connector_delivery_jobs job
                          WHERE job.connector_id=binding.connector_id
                            AND job.idempotency_key='REMINDER:'||reminder.id::text||':'||binding.id::text
                       )
              )
        ORDER BY reminder.scheduled_at,reminder.created_at
        LIMIT 100
        FOR UPDATE OF reminder SKIP LOCKED`,
    );
    for (const reminder of reminders.rows) {
      const summary = [
        `提醒：${reminder.title}`,
        reminder.note.trim() ? reminder.note.trim() : null,
      ]
        .filter(Boolean)
        .join("\n");
      await queueBoundConnectorDeliveriesWithClient(client, {
        ownerId: reminder.owner_id,
        kind: "REMINDER",
        sourceId: reminder.id,
        payload: {
          text: summary,
          summary,
          status: "DUE",
          reminderId: reminder.id,
          assistantId: reminder.assistant_id,
          threadId: reminder.thread_id,
          scheduledAt: reminder.scheduled_at.toISOString(),
        },
      });
    }
  });
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
          AND assistant.deleted_at IS NULL AND thread.deleted_at IS NULL
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
      await queueDuePersonalReminderDeliveries();
      await queueDueExternalReminders();
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
