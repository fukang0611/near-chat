import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import pg from "pg";
import { signToken } from "./auth.js";
import { pool as applicationPool } from "./database.js";
import { apiErrorHandler } from "./http.js";
import {
  finishConnectorEvent,
  finishConnectorJob,
  setConnectorRuntimeState,
} from "./connectors/connector-service.js";
import { createConnectorRouter } from "./routes/connector-routes.js";

const databaseUrl = process.env.CONNECTOR_INTEGRATION_DATABASE_URL;

test(
  "连接器管理写操作与失败队列状态转移写审计且不记录 Webhook",
  { skip: !databaseUrl },
  async () => {
    const setupPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const adminId = randomUUID();
    const app = express();
    app.use(express.json());
    app.use("/api", createConnectorRouter());
    app.use(apiErrorHandler);
    const server = createServer(app);
    let connectorId: string | null = null;
    try {
      await setupPool.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'连接器审计管理员','test','ADMIN','#6757E8')`,
        [adminId, `audit_${adminId.replaceAll("-", "")}`],
      );
      const token = signToken({
        id: adminId,
        username: `audit_${adminId.replaceAll("-", "")}`,
        displayName: "连接器审计管理员",
        role: "ADMIN",
        avatarColor: "#6757E8",
        avatarObjectKey: null,
        avatarVersion: 0,
        statusText: null,
        statusEmoji: null,
        statusExpiresAt: null,
        tokenVersion: 0,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("测试 HTTP 服务没有端口");
      const baseUrl = `http://127.0.0.1:${address.port}/api`;
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...init.headers,
          },
        });
        const body = response.status === 204 ? null : await response.json();
        assert.ok(response.ok, JSON.stringify(body));
        return body as Record<string, unknown> | null;
      };
      const webhookUrl =
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SUPER_SECRET_WEBHOOK_KEY";
      const created = await request("/admin/connectors", {
        method: "POST",
        body: JSON.stringify({
          provider: "WECOM_WEBHOOK",
          name: "审计测试连接器",
          enabled: true,
          config: { webhookUrl },
        }),
      });
      connectorId = (created!.connector as { id: string }).id;
      const manualDelivery = await request(`/admin/connectors/${connectorId}/deliveries`, {
        method: "POST",
        body: JSON.stringify({
          kind: "TEXT",
          idempotencyKey: `manual-${randomUUID()}`,
          payload: {
            text: "可信正文",
            bindingId: randomUUID(),
            dingTalkRoute: {
              conversationType: "1",
              robotCode: "forged-robot",
              senderStaffId: "forged-user",
            },
            encryptedDeliveryTarget: "forged-encrypted-target",
            deliveryTargetExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });
      const manualJobId = (manualDelivery!.delivery as { id: string }).id;
      const manualPayload = await setupPool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM connector_delivery_jobs WHERE id=$1`,
        [manualJobId],
      );
      assert.equal(manualPayload.rows[0]!.payload.text, "可信正文");
      for (const reserved of [
        "bindingId",
        "dingTalkRoute",
        "encryptedDeliveryTarget",
        "deliveryTargetExpiresAt",
      ]) {
        assert.equal(reserved in manualPayload.rows[0]!.payload, false);
      }
      const eventId = randomUUID();
      const olderEventId = randomUUID();
      const jobId = randomUUID();
      const olderJobId = randomUUID();
      await setupPool.query(
        `INSERT INTO connector_events
           (id,connector_id,external_event_id,event_kind,payload,status,error_message,received_at)
         VALUES ($1,$2,$3,'TEXT','{}'::jsonb,'PROCESSING',NULL,NOW()),
                ($4,$2,$5,'TEXT','{}'::jsonb,'FAILED','较早失败',NOW()-INTERVAL '1 day')`,
        [eventId, connectorId, `audit-event-${eventId}`, olderEventId, `older-${olderEventId}`],
      );
      await setupPool.query(
        `INSERT INTO connector_delivery_jobs
           (id,connector_id,kind,payload,status,attempts,idempotency_key,error_message,
            created_at,updated_at)
         VALUES ($1,$2,'TEXT','{}'::jsonb,'RUNNING',5,$3,NULL,NOW(),NOW()),
                ($4,$2,'TEXT','{}'::jsonb,'FAILED',5,$5,'较早失败',
                 NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day')`,
        [jobId, connectorId, `audit-job-${jobId}`, olderJobId, `older-${olderJobId}`],
      );
      const unsafeError = new Error(
        [
          "POST https://gateway.example.test/send?access_token=URL_SECRET",
          "Authorization: Bearer BEARER_SECRET",
          "clientSecret=CLIENT_SECRET token=TOKEN_SECRET",
        ].join("\n"),
      );
      await finishConnectorEvent(eventId, {}, unsafeError);
      await finishConnectorJob(jobId, unsafeError);
      await setConnectorRuntimeState(connectorId, { running: false, error: unsafeError });
      const storedErrors = await setupPool.query<{ error: string }>(
        `SELECT CONCAT_WS(E'\\n',config.last_error,event.error_message,job.error_message) AS error
           FROM connector_configs config
           JOIN connector_events event ON event.connector_id=config.id
           JOIN connector_delivery_jobs job ON job.connector_id=config.id
          WHERE config.id=$1 AND event.id=$2 AND job.id=$3`,
        [connectorId, eventId, jobId],
      );
      assert.doesNotMatch(
        storedErrors.rows[0]!.error,
        /gateway\.example|URL_SECRET|BEARER_SECRET|CLIENT_SECRET|TOKEN_SECRET/,
      );
      const failedEvents = await request(
        `/admin/connectors/operations/events?status=FAILED&connectorId=${connectorId}&limit=1`,
      );
      const failedJobs = await request(
        `/admin/connectors/operations/jobs?status=FAILED&connectorId=${connectorId}&limit=1`,
      );
      const configs = await request("/admin/connectors");
      assert.doesNotMatch(
        JSON.stringify({ failedEvents, failedJobs, configs }),
        /gateway\.example|URL_SECRET|BEARER_SECRET|CLIENT_SECRET|TOKEN_SECRET/,
      );
      assert.equal((failedEvents!.events as Array<{ id: string }>)[0]!.id, eventId);
      const eventCursor = failedEvents!.nextCursor as { before: string; beforeId: string };
      const nextEvents = await request(
        `/admin/connectors/operations/events?status=FAILED&connectorId=${connectorId}&limit=1&before=${encodeURIComponent(eventCursor.before)}&beforeId=${eventCursor.beforeId}`,
      );
      assert.equal((nextEvents!.events as Array<{ id: string }>)[0]!.id, olderEventId);
      assert.equal(nextEvents!.nextCursor, null);
      assert.equal((failedJobs!.jobs as Array<{ id: string }>)[0]!.id, jobId);
      const jobCursor = failedJobs!.nextCursor as { before: string; beforeId: string };
      const nextJobs = await request(
        `/admin/connectors/operations/jobs?status=FAILED&connectorId=${connectorId}&limit=1&before=${encodeURIComponent(jobCursor.before)}&beforeId=${jobCursor.beforeId}`,
      );
      assert.equal((nextJobs!.jobs as Array<{ id: string }>)[0]!.id, olderJobId);
      assert.equal(nextJobs!.nextCursor, null);
      const invalidCursor = await fetch(
        `${baseUrl}/admin/connectors/operations/events?before=${encodeURIComponent(new Date().toISOString())}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(invalidCursor.status, 400);
      await request(`/admin/connectors/operations/events/${eventId}/retry`, { method: "POST" });
      await request(`/admin/connectors/operations/events/${eventId}/cancel`, { method: "POST" });
      await request(`/admin/connectors/operations/jobs/${jobId}/retry`, { method: "POST" });
      await request(`/admin/connectors/operations/jobs/${jobId}/cancel`, { method: "POST" });
      const health = await request("/admin/connectors/operations/health");
      assert.ok((health!.health as { events: { total: number } }).events.total >= 1);
      const events = await request(
        `/admin/connectors/operations/events?status=CANCELLED&connectorId=${connectorId}`,
      );
      assert.equal((events!.events as Array<{ id: string }>)[0]!.id, eventId);
      const jobs = await request(
        `/admin/connectors/operations/jobs?status=CANCELLED&connectorId=${connectorId}`,
      );
      assert.equal((jobs!.jobs as Array<{ id: string }>)[0]!.id, jobId);
      await request(`/admin/connectors/${connectorId}`, { method: "DELETE" });
      connectorId = null;

      const audits = await setupPool.query<{ action: string; details: Record<string, unknown> }>(
        `SELECT action,details FROM audit_logs WHERE actor_id=$1 ORDER BY created_at,id`,
        [adminId],
      );
      assert.deepEqual(
        audits.rows.map((row) => row.action),
        [
          "CONNECTOR_CONFIG_CREATE",
          "CONNECTOR_DELIVERY_QUEUE",
          "CONNECTOR_EVENT_RETRY",
          "CONNECTOR_EVENT_CANCEL",
          "CONNECTOR_JOB_RETRY",
          "CONNECTOR_JOB_CANCEL",
          "CONNECTOR_CONFIG_DELETE",
        ],
      );
      const serialized = JSON.stringify(audits.rows);
      assert.doesNotMatch(serialized, /SUPER_SECRET_WEBHOOK_KEY|qyapi\.weixin\.qq\.com/);
    } finally {
      if (connectorId)
        await setupPool.query(`DELETE FROM connector_configs WHERE id=$1`, [connectorId]);
      await setupPool.query(`DELETE FROM users WHERE id=$1`, [adminId]);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await setupPool.end();
      await applicationPool.end();
    }
  },
);
