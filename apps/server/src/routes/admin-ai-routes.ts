import { Router } from "express";
import { z } from "zod";
import {
  createAiModel,
  deleteAiModel,
  getAdminAiSettings,
  markVectorEmbeddingRevision,
  updateAiModel,
  updateAiSettings,
  type AiRuntimeSettings,
  type AdminAiSettings,
} from "../ai/ai-settings-service.js";
import {
  getAiCapabilities,
  reconfigureAiRuntime,
  type AiRuntimeApplyResult,
} from "../ai/ai-runtime.js";
import { recordAudit } from "../audit-service.js";
import { closeAllAiAssistantBrowserSessions } from "../assistant/assistant-browser-service.js";
import { authenticate, requireAdmin } from "../auth.js";
import { currentUser } from "../http.js";
import { queueAllKnowledgeDocumentsForReindex } from "../knowledge/knowledge-service.js";
import type { RealtimeHub } from "../realtime.js";

const idSchema = z.string().uuid();
const nullableText = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .transform((value) => (typeof value === "string" && value.trim() ? value.trim() : null));
const nullableUrl = z.union([z.string().max(500), z.null()]).transform((value, context) => {
  const normalized = typeof value === "string" && value.trim() ? value.trim() : null;
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return normalized.replace(/\/$/, "");
  } catch {
    context.addIssue({ code: "custom", message: "服务地址必须是 http 或 https URL" });
    return z.NEVER;
  }
});
const optionalSecret = z.union([z.string().trim().min(1).max(2000), z.null()]).optional();

const settingsSchema = z.object({
  enabled: z.boolean(),
  defaultChatModelId: z.union([z.string().uuid(), z.null()]),
  embeddingBaseUrl: nullableUrl,
  embeddingApiKey: optionalSecret,
  embeddingModel: nullableText(200),
  embeddingDimensions: z.number().int().min(1).max(4000),
});

const modelSchema = z.object({
  name: z.string().trim().min(1, "请输入模型显示名称").max(80),
  baseUrl: nullableUrl,
  apiKey: optionalSecret,
  providerModel: z.string().trim().min(1, "请输入模型标识").max(200),
  enabled: z.boolean(),
});

async function applyAndBroadcast(
  realtime: RealtimeHub,
  runtime: AiRuntimeSettings,
  embeddingChanged: boolean,
): Promise<AiRuntimeApplyResult & { reindexQueued: number }> {
  const applied = await reconfigureAiRuntime(runtime);
  if (!runtime.enabled) await closeAllAiAssistantBrowserSessions();
  let reindexQueued = 0;
  if (embeddingChanged || applied.indexRecreated) {
    reindexQueued = await queueAllKnowledgeDocumentsForReindex();
  }
  if (applied.indexRecreated) {
    await markVectorEmbeddingRevision(runtime.embeddingRevision);
  }
  realtime.sendToUsers(realtime.onlineUserIds(), {
    type: "ai.capabilities.changed",
    payload: { capabilities: applied.capabilities },
  });
  return { ...applied, reindexQueued };
}

function responseBody(
  settings: AdminAiSettings,
  applied: AiRuntimeApplyResult & { reindexQueued: number },
) {
  return {
    settings,
    capabilities: applied.capabilities,
    reindexQueued: applied.reindexQueued,
  };
}

/** 全局 AI 与模型目录管理。所有写操作均立即热应用，不需要重启服务。 */
export function createAdminAiRouter(realtime: RealtimeHub) {
  const router = Router();

  router.get("/admin/ai-settings", authenticate, requireAdmin, async (_request, response) => {
    response.json({
      settings: await getAdminAiSettings(),
      capabilities: getAiCapabilities(),
    });
  });

  router.put("/admin/ai-settings", authenticate, requireAdmin, async (request, response) => {
    const admin = currentUser(request);
    const input = settingsSchema.parse(request.body);
    const updated = await updateAiSettings(admin.id, input);
    const applied = await applyAndBroadcast(realtime, updated.runtime, updated.embeddingChanged);
    await recordAudit({
      actorId: admin.id,
      action: "ADMIN_AI_SETTINGS_UPDATE",
      targetType: "AI_SETTINGS",
      targetId: "global",
      details: {
        enabled: input.enabled,
        defaultChatModelId: updated.settings.defaultChatModelId,
        embeddingModel: input.embeddingModel,
        embeddingBaseUrl: input.embeddingBaseUrl,
        embeddingDimensions: input.embeddingDimensions,
        embeddingKeyChanged: input.embeddingApiKey !== undefined,
        reindexQueued: applied.reindexQueued,
      },
    });
    response.json(responseBody(updated.settings, applied));
  });

  router.post("/admin/ai-models", authenticate, requireAdmin, async (request, response) => {
    const admin = currentUser(request);
    const input = modelSchema.parse(request.body);
    const created = await createAiModel(admin.id, input);
    const applied = await applyAndBroadcast(realtime, created.runtime, false);
    await recordAudit({
      actorId: admin.id,
      action: "ADMIN_AI_MODEL_CREATE",
      targetType: "AI_MODEL",
      targetId: created.modelId,
      details: {
        name: input.name,
        providerModel: input.providerModel,
        baseUrl: input.baseUrl,
        enabled: input.enabled,
        keyConfigured: Boolean(input.apiKey),
      },
    });
    response.status(201).json(responseBody(created.settings, applied));
  });

  router.put("/admin/ai-models/:modelId", authenticate, requireAdmin, async (request, response) => {
    const admin = currentUser(request);
    const modelId = idSchema.parse(request.params.modelId);
    const input = modelSchema.parse(request.body);
    const updated = await updateAiModel(admin.id, modelId, input);
    const applied = await applyAndBroadcast(realtime, updated.runtime, false);
    await recordAudit({
      actorId: admin.id,
      action: "ADMIN_AI_MODEL_UPDATE",
      targetType: "AI_MODEL",
      targetId: modelId,
      details: {
        name: input.name,
        providerModel: input.providerModel,
        baseUrl: input.baseUrl,
        enabled: input.enabled,
        keyChanged: input.apiKey !== undefined,
      },
    });
    response.json(responseBody(updated.settings, applied));
  });

  router.delete(
    "/admin/ai-models/:modelId",
    authenticate,
    requireAdmin,
    async (request, response) => {
      const admin = currentUser(request);
      const modelId = idSchema.parse(request.params.modelId);
      const updated = await deleteAiModel(admin.id, modelId);
      const applied = await applyAndBroadcast(realtime, updated.runtime, false);
      await recordAudit({
        actorId: admin.id,
        action: "ADMIN_AI_MODEL_DELETE",
        targetType: "AI_MODEL",
        targetId: modelId,
      });
      response.json(responseBody(updated.settings, applied));
    },
  );

  return router;
}
