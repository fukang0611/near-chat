import express, { Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin } from "../auth.js";
import { recordAudit } from "../audit-service.js";
import { currentUser, ApiError } from "../http.js";
import {
  cancelConnectorEvent,
  cancelConnectorJob,
  connectorQueueHealth,
  CONNECTOR_EVENT_STATUSES,
  CONNECTOR_JOB_STATUSES,
  createConnectorConfig,
  deleteConnectorBinding,
  deleteConnectorConfig,
  encryptConnectorReplyTarget,
  listConnectorBindings,
  listConnectorConfigs,
  listConnectorEventsForAdmin,
  listConnectorIdentities,
  listConnectorJobsForAdmin,
  loadConnectorConfig,
  mapConnectorIdentity,
  queueConnectorDelivery,
  recordConnectorEvent,
  retryConnectorEvent,
  retryConnectorJob,
  saveConnectorBinding,
  updateConnectorConfig,
} from "../connectors/connector-service.js";
import { reconcileConnectorRuntime, stopConnectorRuntime } from "../connectors/connector-worker.js";
import {
  encryptedWeComEnvelope,
  parseWeComTextMessage,
  verifyAndDecryptWeComCallback,
} from "../connectors/wecom-callback.js";

const idSchema = z.string().uuid();
const providerSchema = z.enum(["DINGTALK_STREAM", "WECOM_WEBHOOK", "WECOM_CALLBACK"]);
const deliveryKindSchema = z.enum(["TASK_RESULT", "REMINDER", "SUMMARY", "TEXT"]);
const configFields = {
  clientId: z.string().trim().optional(),
  clientSecret: z.string().trim().optional(),
  webhookUrl: z.string().trim().optional(),
  callbackToken: z.string().trim().optional(),
  encodingAesKey: z.string().trim().optional(),
  corpId: z.string().trim().optional(),
  agentId: z.string().trim().optional(),
};
const callbackQuerySchema = z.object({
  msg_signature: z.string().trim().min(1),
  timestamp: z.string().trim().regex(/^\d+$/),
  nonce: z.string().trim().min(1).max(200),
});

async function weComCallbackConfig(connectorId: string) {
  const loaded = await loadConnectorConfig(connectorId);
  if (loaded.config.provider !== "WECOM_CALLBACK") {
    throw new ApiError(404, "企业微信回调连接器不存在或未启用");
  }
  return loaded.payload;
}

function verifyWeCom(input: Parameters<typeof verifyAndDecryptWeComCallback>[0]): string {
  try {
    return verifyAndDecryptWeComCallback(input);
  } catch {
    throw new ApiError(401, "企业微信回调验证失败");
  }
}

export function createConnectorRouter() {
  const router = Router();

  // 外部平台无法携带 NearChat JWT；公开回调必须位于管理员中间件之前，并自行完成签名校验。
  router.get("/connectors/wecom/:connectorId/callback", async (request, response) => {
    const connectorId = idSchema.parse(request.params.connectorId);
    const query = callbackQuerySchema
      .extend({ echostr: z.string().trim().min(1) })
      .parse(request.query);
    const config = await weComCallbackConfig(connectorId);
    const echo = verifyWeCom({
      config,
      signature: query.msg_signature,
      timestamp: query.timestamp,
      nonce: query.nonce,
      encrypted: query.echostr,
    });
    response.type("text/plain").send(echo);
  });

  router.post(
    "/connectors/wecom/:connectorId/callback",
    express.text({ type: ["application/xml", "text/xml"], limit: "256kb" }),
    async (request, response) => {
      const connectorId = idSchema.parse(request.params.connectorId);
      const callbackQuery = callbackQuerySchema.parse(request.query);
      if (typeof request.body !== "string" || !request.body.trim()) {
        throw new ApiError(400, "企业微信回调正文为空");
      }
      const config = await weComCallbackConfig(connectorId);
      let encrypted: string;
      try {
        encrypted = encryptedWeComEnvelope(request.body);
      } catch {
        throw new ApiError(400, "企业微信回调 XML 无效");
      }
      const plaintext = verifyWeCom({
        config,
        signature: callbackQuery.msg_signature,
        timestamp: callbackQuery.timestamp,
        nonce: callbackQuery.nonce,
        encrypted,
      });
      const message = parseWeComTextMessage(connectorId, plaintext, config.agentId!);
      if (message) {
        await recordConnectorEvent({
          connectorId,
          message,
          encryptedReplyTarget: encryptConnectorReplyTarget(message.externalUserId),
        });
      }
      // 只有事件事务提交后才确认；重复 MsgId 由唯一约束收敛为同一事件。
      response.type("text/plain").send("success");
    },
  );

  router.use(authenticate, requireAdmin);

  router.get("/admin/connectors", async (_request, response) =>
    response.json({ connectors: await listConnectorConfigs() }),
  );

  const eventOperationQuery = z
    .object({
      connectorId: idSchema.optional(),
      status: z.enum(CONNECTOR_EVENT_STATUSES).default("FAILED"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      before: z.string().datetime({ offset: true }).optional(),
      beforeId: idSchema.optional(),
    })
    .refine((value) => Boolean(value.before) === Boolean(value.beforeId), {
      message: "before 与 beforeId 必须同时提供",
      path: ["before"],
    });
  const jobOperationQuery = z
    .object({
      connectorId: idSchema.optional(),
      status: z.enum(CONNECTOR_JOB_STATUSES).default("FAILED"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      before: z.string().datetime({ offset: true }).optional(),
      beforeId: idSchema.optional(),
    })
    .refine((value) => Boolean(value.before) === Boolean(value.beforeId), {
      message: "before 与 beforeId 必须同时提供",
      path: ["before"],
    });

  router.get("/admin/connectors/operations/health", async (_request, response) => {
    response.json({ health: await connectorQueueHealth() });
  });

  router.get("/admin/connectors/operations/events", async (request, response) => {
    const page = await listConnectorEventsForAdmin(eventOperationQuery.parse(request.query));
    response.json({
      events: page.items,
      nextCursor: page.nextCursor,
    });
  });

  router.post("/admin/connectors/operations/events/:eventId/retry", async (request, response) => {
    const event = await retryConnectorEvent(idSchema.parse(request.params.eventId));
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_EVENT_RETRY",
      targetType: "CONNECTOR_EVENT",
      targetId: event.id,
      details: { connectorId: event.connector_id, status: event.status },
    });
    response.json({
      event: { id: event.id, connectorId: event.connector_id, status: event.status },
    });
  });

  router.post("/admin/connectors/operations/events/:eventId/cancel", async (request, response) => {
    const event = await cancelConnectorEvent(idSchema.parse(request.params.eventId));
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_EVENT_CANCEL",
      targetType: "CONNECTOR_EVENT",
      targetId: event.id,
      details: { connectorId: event.connector_id, status: event.status },
    });
    response.json({
      event: { id: event.id, connectorId: event.connector_id, status: event.status },
    });
  });

  router.get("/admin/connectors/operations/jobs", async (request, response) => {
    const page = await listConnectorJobsForAdmin(jobOperationQuery.parse(request.query));
    response.json({
      jobs: page.items,
      nextCursor: page.nextCursor,
    });
  });

  router.post("/admin/connectors/operations/jobs/:jobId/retry", async (request, response) => {
    const job = await retryConnectorJob(idSchema.parse(request.params.jobId));
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_JOB_RETRY",
      targetType: "CONNECTOR_DELIVERY_JOB",
      targetId: job.id,
      details: { connectorId: job.connector_id, status: job.status },
    });
    response.json({ job: { id: job.id, connectorId: job.connector_id, status: job.status } });
  });

  router.post("/admin/connectors/operations/jobs/:jobId/cancel", async (request, response) => {
    const job = await cancelConnectorJob(idSchema.parse(request.params.jobId));
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_JOB_CANCEL",
      targetType: "CONNECTOR_DELIVERY_JOB",
      targetId: job.id,
      details: { connectorId: job.connector_id, status: job.status },
    });
    response.json({ job: { id: job.id, connectorId: job.connector_id, status: job.status } });
  });

  router.post("/admin/connectors", async (request, response) => {
    const input = z
      .object({
        provider: providerSchema,
        name: z.string().trim().min(1).max(120),
        enabled: z.boolean().default(false),
        config: z.object(configFields),
      })
      .parse(request.body);
    const connector = await createConnectorConfig(currentUser(request).id, input);
    const runtime = await reconcileConnectorRuntime(connector.id);
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_CONFIG_CREATE",
      targetType: "CONNECTOR_CONFIG",
      targetId: connector.id,
      details: { provider: input.provider, name: input.name, enabled: input.enabled },
    });
    response.status(201).json({ connector, runtime });
  });

  router.patch("/admin/connectors/:connectorId", async (request, response) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        enabled: z.boolean().optional(),
        revision: z.number().int().positive(),
        config: z
          .object({
            clientId: z.string().trim().nullable().optional(),
            clientSecret: z.string().trim().nullable().optional(),
            webhookUrl: z.string().trim().nullable().optional(),
            callbackToken: z.string().trim().nullable().optional(),
            encodingAesKey: z.string().trim().nullable().optional(),
            corpId: z.string().trim().nullable().optional(),
            agentId: z.string().trim().nullable().optional(),
          })
          .optional(),
      })
      .parse(request.body);
    const connectorId = idSchema.parse(request.params.connectorId);
    const connector = await updateConnectorConfig(connectorId, input);
    const runtime = await reconcileConnectorRuntime(connectorId);
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_CONFIG_UPDATE",
      targetType: "CONNECTOR_CONFIG",
      targetId: connectorId,
      details: {
        nameChanged: input.name !== undefined,
        enabled: input.enabled,
        configUpdated: input.config !== undefined,
        revision: connector.revision,
      },
    });
    response.json({ connector, runtime });
  });

  router.delete("/admin/connectors/:connectorId", async (request, response) => {
    const connectorId = idSchema.parse(request.params.connectorId);
    stopConnectorRuntime(connectorId);
    await deleteConnectorConfig(connectorId);
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_CONFIG_DELETE",
      targetType: "CONNECTOR_CONFIG",
      targetId: connectorId,
    });
    response.status(204).end();
  });

  router.post("/admin/connectors/:connectorId/deliveries", async (request, response) => {
    const input = z
      .object({
        kind: z.string().trim().min(1).max(40),
        payload: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().trim().min(1).max(200),
        deliveryTarget: z.string().trim().min(1).max(2_000).optional(),
        deliveryTargetExpiresAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.body);
    const queued = await queueConnectorDelivery({
      connectorId: idSchema.parse(request.params.connectorId),
      ...input,
    });
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_DELIVERY_QUEUE",
      targetType: "CONNECTOR_DELIVERY_JOB",
      targetId: queued.id,
      details: {
        connectorId: idSchema.parse(request.params.connectorId),
        kind: input.kind,
        created: queued.created,
      },
    });
    response.status(queued.created ? 202 : 200).json({ delivery: queued });
  });

  router.get("/admin/connectors/:connectorId/identities", async (request, response) => {
    response.json({
      identities: await listConnectorIdentities(idSchema.parse(request.params.connectorId)),
    });
  });

  router.put("/admin/connectors/:connectorId/identities", async (request, response) => {
    const input = z
      .object({
        externalUserId: z.string().trim().min(1).max(200),
        nearChatUserId: idSchema.nullable(),
      })
      .parse(request.body);
    const identity = await mapConnectorIdentity({
      connectorId: idSchema.parse(request.params.connectorId),
      ...input,
    });
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_IDENTITY_MAP",
      targetType: "CONNECTOR_IDENTITY",
      targetId: identity.id,
      details: {
        connectorId: identity.connectorId,
        externalUserId: identity.externalUserId,
        nearChatUserId: identity.nearChatUserId,
      },
    });
    response.json({ identity });
  });

  router.get("/admin/connectors/:connectorId/bindings", async (request, response) => {
    response.json({
      bindings: await listConnectorBindings(idSchema.parse(request.params.connectorId)),
    });
  });

  router.put("/admin/connectors/:connectorId/bindings", async (request, response) => {
    const input = z
      .object({
        id: idSchema.optional(),
        ownerId: idSchema,
        externalConversationId: z.string().trim().min(1).max(200),
        nearChatConversationId: idSchema.nullable().optional(),
        assistantId: idSchema.nullable().optional(),
        deliveryKinds: z.array(deliveryKindSchema).default([]),
        deliveryTarget: z.string().trim().min(1).max(2_000).nullable().optional(),
        deliveryTargetExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
        enabled: z.boolean().default(true),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body);
    const binding = await saveConnectorBinding({
      connectorId: idSchema.parse(request.params.connectorId),
      ...input,
    });
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_BINDING_SAVE",
      targetType: "CONNECTOR_BINDING",
      targetId: binding.id,
      details: {
        connectorId: binding.connectorId,
        ownerId: binding.ownerId,
        deliveryKinds: binding.deliveryKinds,
        enabled: binding.enabled,
        hasDeliveryTarget: binding.hasDeliveryTarget,
      },
    });
    response.json({ binding });
  });

  router.delete("/admin/connectors/:connectorId/bindings/:bindingId", async (request, response) => {
    const connectorId = idSchema.parse(request.params.connectorId);
    const bindingId = idSchema.parse(request.params.bindingId);
    await deleteConnectorBinding(connectorId, bindingId);
    await recordAudit({
      actorId: currentUser(request).id,
      action: "CONNECTOR_BINDING_DELETE",
      targetType: "CONNECTOR_BINDING",
      targetId: bindingId,
      details: { connectorId },
    });
    response.status(204).end();
  });

  return router;
}
