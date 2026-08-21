import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sendAiAssistantMessageFromConnectorEvent } from "./assistant/assistant-service.js";
import {
  cancelConnectorEvent,
  cancelConnectorJob,
  connectorQueueHealth,
  deleteConnectorBinding,
  findConnectorBinding,
  listConnectorEventsForAdmin,
  listConnectorJobsForAdmin,
  retryConnectorEvent,
  retryConnectorJob,
  saveConnectorBinding,
} from "./connectors/connector-service.js";
import { pool as applicationPool } from "./database.js";

const databaseUrl = process.env.CONNECTOR_INTEGRATION_DATABASE_URL;

test(
  "连接器事件复用已提交助理消息且失败队列支持可审计状态转移",
  { skip: !databaseUrl },
  async () => {
    const setupPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const ownerId = randomUUID();
    const assistantId = randomUUID();
    const threadId = randomUUID();
    const connectorId = randomUUID();
    const bindingId = randomUUID();
    const eventId = randomUUID();
    const jobId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    try {
      await setupPool.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'恢复测试用户','test','ADMIN','#6757E8')`,
        [ownerId, `recovery_${ownerId.replaceAll("-", "")}`],
      );
      await setupPool.query(
        `INSERT INTO ai_assistants (id,owner_id,name,instructions)
         VALUES ($1,$2,'恢复测试助理','仅测试持久幂等')`,
        [assistantId, ownerId],
      );
      await setupPool.query(
        `INSERT INTO ai_assistant_threads (id,assistant_id,owner_id,title,is_default)
         VALUES ($1,$2,$3,'默认对话',TRUE)`,
        [threadId, assistantId, ownerId],
      );
      await setupPool.query(
        `INSERT INTO connector_configs
           (id,provider,name,enabled,config_encrypted,created_by)
         VALUES ($1,'DINGTALK_STREAM',$2,TRUE,'test',$3)`,
        [connectorId, `recovery-${connectorId}`, ownerId],
      );
      const dingTalkRoute = {
        conversationType: "2",
        robotCode: "recovery-robot",
        senderStaffId: "recovery-staff",
        openConversationId: "recovery-conversation",
      };
      await setupPool.query(
        `INSERT INTO connector_bindings
           (id,connector_id,owner_id,external_conversation_id,delivery_kinds,metadata)
         VALUES ($1,$2,$3,'recovery-conversation',ARRAY['TEXT']::varchar[],$4)`,
        [bindingId, connectorId, ownerId, dingTalkRoute],
      );
      await setupPool.query(
        `INSERT INTO connector_events
           (id,connector_id,external_event_id,event_kind,payload,status,error_message)
         VALUES ($1,$2,$3,'TEXT','{}'::jsonb,'FAILED','模拟崩溃窗口')`,
        [eventId, connectorId, `event-${eventId}`],
      );
      await setupPool.query(
        `INSERT INTO ai_assistant_messages
           (id,assistant_id,thread_id,role,content,sources,connector_event_id,created_at)
         VALUES ($1,$2,$3,'USER','外部用户原始请求','[]'::jsonb,$4,NOW()),
                ($5,$2,$3,'ASSISTANT','已提交且必须复用的回复','[]'::jsonb,$4,
                 NOW()+INTERVAL '1 millisecond')`,
        [userMessageId, assistantId, threadId, eventId, assistantMessageId],
      );
      await setupPool.query(
        `INSERT INTO connector_delivery_jobs
           (id,connector_id,kind,payload,status,attempts,idempotency_key,error_message)
         VALUES ($1,$2,'TEXT',$3,'FAILED',5,$4,'模拟外发失败')`,
        [
          jobId,
          connectorId,
          { bindingId, dingTalkRoute: { ...dingTalkRoute, robotCode: "stale-robot" } },
          `job-${jobId}`,
        ],
      );

      const publicBinding = await findConnectorBinding(connectorId, "recovery-conversation");
      assert.ok(publicBinding);
      assert.equal(publicBinding.hasDingTalkOpenApiRoute, true);
      assert.deepEqual(publicBinding.metadata, {});
      await assert.rejects(
        saveConnectorBinding({
          id: bindingId,
          connectorId,
          ownerId,
          externalConversationId: "different-conversation",
          deliveryKinds: ["TEXT"],
          enabled: true,
        }),
        /外部会话不可更改/,
      );
      const savedBinding = await saveConnectorBinding({
        id: bindingId,
        connectorId,
        ownerId,
        externalConversationId: "recovery-conversation",
        deliveryKinds: ["TEXT"],
        enabled: true,
      });
      assert.equal(savedBinding.hasDingTalkOpenApiRoute, true);
      assert.deepEqual(savedBinding.metadata, {});
      const synchronizedJob = await setupPool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM connector_delivery_jobs WHERE id=$1`,
        [jobId],
      );
      assert.deepEqual(synchronizedJob.rows[0]!.payload.dingTalkRoute, dingTalkRoute);

      const messages = await sendAiAssistantMessageFromConnectorEvent(
        ownerId,
        assistantId,
        threadId,
        "这段文字不应再次进入模型",
        eventId,
      );
      assert.deepEqual(
        messages.map((message) => message.id),
        [userMessageId, assistantMessageId],
      );
      const messageCount = await setupPool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ai_assistant_messages WHERE connector_event_id=$1`,
        [eventId],
      );
      assert.equal(messageCount.rows[0]!.total, "2");
      await assert.rejects(
        setupPool.query(
          `INSERT INTO ai_assistant_messages
             (id,assistant_id,thread_id,role,content,sources,connector_event_id)
           VALUES ($1,$2,$3,'USER','重复','[]'::jsonb,$4)`,
          [randomUUID(), assistantId, threadId, eventId],
        ),
        (error) => (error as { code?: string }).code === "23505",
      );

      assert.equal((await retryConnectorEvent(eventId)).status, "RECEIVED");
      assert.equal((await cancelConnectorEvent(eventId)).status, "CANCELLED");
      assert.equal((await retryConnectorEvent(eventId)).status, "RECEIVED");
      assert.equal((await retryConnectorJob(jobId)).status, "QUEUED");
      const refreshedJob = await setupPool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM connector_delivery_jobs WHERE id=$1`,
        [jobId],
      );
      assert.deepEqual(refreshedJob.rows[0]!.payload.dingTalkRoute, dingTalkRoute);
      assert.equal((await cancelConnectorJob(jobId)).status, "CANCELLED");
      assert.equal((await retryConnectorJob(jobId)).status, "QUEUED");
      assert.equal(
        (await listConnectorEventsForAdmin({ status: "RECEIVED", limit: 100 })).items.some(
          (event) => event.id === eventId,
        ),
        true,
      );
      assert.equal(
        (await listConnectorJobsForAdmin({ status: "QUEUED", limit: 100 })).items.some(
          (job) => job.id === jobId,
        ),
        true,
      );
      const health = await connectorQueueHealth();
      assert.ok(health.events.total >= 1);
      assert.ok(health.jobs.total >= 1);

      await saveConnectorBinding({
        id: bindingId,
        connectorId,
        ownerId,
        externalConversationId: "recovery-conversation",
        deliveryKinds: ["TEXT"],
        enabled: false,
      });
      assert.equal(
        (
          await setupPool.query<{ status: string }>(
            `SELECT status FROM connector_delivery_jobs WHERE id=$1`,
            [jobId],
          )
        ).rows[0]!.status,
        "CANCELLED",
      );
      await setupPool.query(
        `UPDATE connector_delivery_jobs SET status='FAILED',attempts=5 WHERE id=$1`,
        [jobId],
      );
      await assert.rejects(retryConnectorJob(jobId), /绑定已删除、停用或不再允许/);

      await saveConnectorBinding({
        id: bindingId,
        connectorId,
        ownerId,
        externalConversationId: "recovery-conversation",
        deliveryKinds: ["TEXT"],
        enabled: true,
      });
      assert.equal((await retryConnectorJob(jobId)).status, "QUEUED");
      await saveConnectorBinding({
        id: bindingId,
        connectorId,
        ownerId,
        externalConversationId: "recovery-conversation",
        deliveryKinds: [],
        enabled: true,
      });
      assert.equal(
        (
          await setupPool.query<{ status: string }>(
            `SELECT status FROM connector_delivery_jobs WHERE id=$1`,
            [jobId],
          )
        ).rows[0]!.status,
        "CANCELLED",
      );
      await setupPool.query(
        `UPDATE connector_delivery_jobs SET status='FAILED',attempts=5 WHERE id=$1`,
        [jobId],
      );
      await assert.rejects(retryConnectorJob(jobId), /绑定已删除、停用或不再允许/);

      await saveConnectorBinding({
        id: bindingId,
        connectorId,
        ownerId,
        externalConversationId: "recovery-conversation",
        deliveryKinds: ["TEXT"],
        enabled: true,
      });
      assert.equal((await retryConnectorJob(jobId)).status, "QUEUED");
      await deleteConnectorBinding(connectorId, bindingId);
      assert.equal(
        (
          await setupPool.query<{ status: string }>(
            `SELECT status FROM connector_delivery_jobs WHERE id=$1`,
            [jobId],
          )
        ).rows[0]!.status,
        "CANCELLED",
      );
      await setupPool.query(
        `UPDATE connector_delivery_jobs SET status='FAILED',attempts=5 WHERE id=$1`,
        [jobId],
      );
      await assert.rejects(retryConnectorJob(jobId), /绑定已删除、停用或不再允许/);
    } finally {
      await setupPool.query(`DELETE FROM connector_configs WHERE id=$1`, [connectorId]);
      await setupPool.query(`DELETE FROM ai_assistants WHERE id=$1`, [assistantId]);
      await setupPool.query(`DELETE FROM users WHERE id=$1`, [ownerId]);
      await setupPool.end();
      await applicationPool.end();
    }
  },
);
