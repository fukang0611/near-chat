import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { queueDuePersonalReminderDeliveriesWithClient } from "./assistant/assistant-reminder-worker.js";
import {
  nextConnectorEventsWithClient,
  queueBoundConnectorDeliveriesWithClient,
  recordConnectorEventWithClient,
} from "./connectors/connector-service.js";

const databaseUrl = process.env.CONNECTOR_INTEGRATION_DATABASE_URL;

test(
  "个人提醒到期时原子写入 connector outbox、通知状态和同步投影",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ownerId = randomUUID();
      const connectorId = randomUUID();
      const bindingId = randomUUID();
      const reminderId = randomUUID();
      const username = `connector_${ownerId.replaceAll("-", "")}`;
      const scheduledAt = new Date(Date.now() - 60_000);
      await client.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'连接器提醒测试','test','USER','#6757E8')`,
        [ownerId, username],
      );
      await client.query(
        `INSERT INTO connector_configs
           (id,provider,name,enabled,config_encrypted,created_by)
         VALUES ($1,'WECOM_WEBHOOK',$2,TRUE,'test',$3)`,
        [connectorId, `connector-${connectorId}`, ownerId],
      );
      await client.query(
        `INSERT INTO connector_bindings
           (id,connector_id,owner_id,external_conversation_id,delivery_kinds)
         VALUES ($1,$2,$3,$4,ARRAY['REMINDER']::varchar[])`,
        [bindingId, connectorId, ownerId, `conversation-${bindingId}`],
      );
      const inserted = await client.query<{
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO personal_reminders
           (id,owner_id,title,note,scheduled_at)
         VALUES ($1,$2,'跨设备提醒','检查 connector outbox',$3)
         RETURNING created_at,updated_at`,
        [reminderId, ownerId, scheduledAt],
      );
      const initial = {
        id: reminderId,
        title: "跨设备提醒",
        note: "检查 connector outbox",
        scheduledAt: scheduledAt.toISOString(),
        completedAt: null,
        notifiedAt: null,
        revision: 1,
        createdAt: inserted.rows[0]!.created_at.toISOString(),
        updatedAt: inserted.rows[0]!.updated_at.toISOString(),
      };
      await client.query(
        `INSERT INTO sync_entity_snapshots
           (owner_id,entity_type,entity_id,revision,payload)
         VALUES ($1,'PERSONAL_REMINDER',$2,1,$3)`,
        [ownerId, reminderId, initial],
      );

      await queueDuePersonalReminderDeliveriesWithClient(client);
      await queueDuePersonalReminderDeliveriesWithClient(client);

      const reminder = await client.query<{
        notified_at: Date | null;
        revision: number;
      }>(`SELECT notified_at,revision FROM personal_reminders WHERE id=$1`, [reminderId]);
      assert.ok(reminder.rows[0]!.notified_at);
      assert.equal(reminder.rows[0]!.revision, 2);

      const jobs = await client.query<{
        idempotency_key: string;
        payload: Record<string, unknown>;
      }>(`SELECT idempotency_key,payload FROM connector_delivery_jobs WHERE connector_id=$1`, [
        connectorId,
      ]);
      assert.equal(jobs.rows.length, 1);
      assert.equal(jobs.rows[0]!.idempotency_key, `REMINDER:${reminderId}:${bindingId}`);
      assert.equal(jobs.rows[0]!.payload.source, "PERSONAL_REMINDER");

      const snapshot = await client.query<{
        revision: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT revision,payload FROM sync_entity_snapshots
          WHERE owner_id=$1 AND entity_type='PERSONAL_REMINDER' AND entity_id=$2`,
        [ownerId, reminderId],
      );
      assert.equal(snapshot.rows[0]!.revision, 2);
      assert.equal(snapshot.rows[0]!.payload.revision, 2);
      assert.equal(
        snapshot.rows[0]!.payload.notifiedAt,
        reminder.rows[0]!.notified_at!.toISOString(),
      );
      const changes = await client.query<{ revision: number }>(
        `SELECT revision FROM sync_changes
          WHERE owner_id=$1 AND entity_type='PERSONAL_REMINDER' AND entity_id=$2`,
        [ownerId, reminderId],
      );
      assert.deepEqual(
        changes.rows.map((row) => row.revision),
        [2],
      );

      await assert.rejects(
        queueBoundConnectorDeliveriesWithClient(client, {
          ownerId,
          kind: "REMINDER",
          sourceId: reminderId,
          payload: { text: "同一个幂等键的不同内容" },
        }),
        /幂等键已被不同内容使用/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);

test(
  "钉钉入站消息刷新绑定的临时会话目标且出站任务携带失效时间",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ownerId = randomUUID();
      const connectorId = randomUUID();
      const bindingId = randomUUID();
      const eventId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const dingTalkRoute = {
        conversationType: "2" as const,
        robotCode: "robot-code",
        senderStaffId: "ding-user",
        openConversationId: "ding-conversation",
      };
      await client.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'钉钉目标测试','test','USER','#6757E8')`,
        [ownerId, `ding_target_${ownerId.replaceAll("-", "")}`],
      );
      await client.query(
        `INSERT INTO connector_configs
           (id,provider,name,enabled,config_encrypted,created_by)
         VALUES ($1,'DINGTALK_STREAM',$2,TRUE,'test',$3)`,
        [connectorId, `ding-${connectorId}`, ownerId],
      );
      await client.query(
        `INSERT INTO connector_bindings
           (id,connector_id,owner_id,external_conversation_id,delivery_kinds)
         VALUES ($1,$2,$3,'ding-conversation',ARRAY['REMINDER']::varchar[])`,
        [bindingId, connectorId, ownerId],
      );
      const failedJobs = await queueBoundConnectorDeliveriesWithClient(client, {
        ownerId,
        kind: "REMINDER",
        sourceId: randomUUID(),
        payload: { text: "钉钉失败提醒" },
      });
      const queuedJobs = await queueBoundConnectorDeliveriesWithClient(client, {
        ownerId,
        kind: "REMINDER",
        sourceId: randomUUID(),
        payload: { text: "钉钉排队提醒" },
      });
      await client.query(
        `UPDATE connector_delivery_jobs
            SET status='FAILED',attempts=5,error_message='旧会话已过期'
          WHERE id=$1`,
        [failedJobs[0]!.jobId],
      );
      await recordConnectorEventWithClient(client, {
        connectorId,
        message: {
          connectorId,
          provider: "DINGTALK_STREAM",
          externalEventId: eventId,
          externalMessageId: eventId,
          externalConversationId: "ding-conversation",
          externalUserId: "ding-user",
          externalUserName: "钉钉用户",
          text: "刷新会话目标",
          occurredAt: new Date().toISOString(),
        },
        encryptedReplyTarget: "encrypted-session-webhook",
        replyTargetExpiresAt: expiresAt.toISOString(),
        dingTalkRoute,
      });
      const binding = await client.query<{
        delivery_target_encrypted: string | null;
        delivery_target_expires_at: Date | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT delivery_target_encrypted,delivery_target_expires_at,metadata
           FROM connector_bindings WHERE id=$1`,
        [bindingId],
      );
      assert.equal(binding.rows[0]!.delivery_target_encrypted, "encrypted-session-webhook");
      assert.equal(
        binding.rows[0]!.delivery_target_expires_at!.toISOString(),
        expiresAt.toISOString(),
      );
      assert.deepEqual(binding.rows[0]!.metadata, dingTalkRoute);
      const recovered = await client.query<{
        id: string;
        status: string;
        attempts: number;
        error_message: string | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT id,status,attempts,error_message,payload
           FROM connector_delivery_jobs WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[failedJobs[0]!.jobId, queuedJobs[0]!.jobId]],
      );
      assert.equal(recovered.rowCount, 2);
      for (const job of recovered.rows) {
        assert.equal(job.status, "QUEUED");
        assert.equal(job.attempts, 0);
        assert.equal(job.error_message, null);
        assert.equal(job.payload.encryptedDeliveryTarget, "encrypted-session-webhook");
        assert.equal(job.payload.deliveryTargetExpiresAt, expiresAt.toISOString());
        assert.deepEqual(job.payload.dingTalkRoute, dingTalkRoute);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);

test("禁用连接器的旧事件不会占满 LIMIT 并饿死启用连接器事件", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ownerId = randomUUID();
    const disabledConnectorId = randomUUID();
    const enabledConnectorId = randomUUID();
    const disabledEventId = randomUUID();
    const enabledEventId = randomUUID();
    await client.query(
      `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'饥饿测试','test','USER','#6757E8')`,
      [ownerId, `starvation_${ownerId.replaceAll("-", "")}`],
    );
    await client.query(
      `INSERT INTO connector_configs
           (id,provider,name,enabled,config_encrypted,created_by)
         VALUES ($1,'WECOM_WEBHOOK',$2,FALSE,'test',$3),
                ($4,'WECOM_WEBHOOK',$5,TRUE,'test',$3)`,
      [
        disabledConnectorId,
        `disabled-${disabledConnectorId}`,
        ownerId,
        enabledConnectorId,
        `enabled-${enabledConnectorId}`,
      ],
    );
    await client.query(
      `INSERT INTO connector_events
           (id,connector_id,external_event_id,event_kind,payload,status,received_at)
         VALUES ($1,$2,$3,'TEXT','{}'::jsonb,'RECEIVED','2000-01-01T00:00:00Z'),
                ($4,$5,$6,'TEXT','{}'::jsonb,'RECEIVED','2000-01-02T00:00:00Z')`,
      [
        disabledEventId,
        disabledConnectorId,
        `disabled-${disabledEventId}`,
        enabledEventId,
        enabledConnectorId,
        `enabled-${enabledEventId}`,
      ],
    );

    const claimed = await nextConnectorEventsWithClient(client, 1, 60);
    assert.deepEqual(
      claimed.map((event) => event.id),
      [enabledEventId],
    );
    const disabled = await client.query<{ status: string }>(
      `SELECT status FROM connector_events WHERE id=$1`,
      [disabledEventId],
    );
    assert.equal(disabled.rows[0]!.status, "RECEIVED");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
