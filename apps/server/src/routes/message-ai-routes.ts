import { Router } from "express";
import { z } from "zod";
import { getAiCapabilities } from "../ai/ai-runtime.js";
import { runMessageAiAction } from "../ai/message-ai-service.js";
import { authenticate } from "../auth.js";
import { ApiError, currentUser } from "../http.js";

const idSchema = z.string().uuid();
const actionSchema = z.object({
  action: z.enum(["SUMMARIZE", "EXTRACT_TASKS", "REWRITE", "TRANSLATE", "ANALYZE"]),
  targetLanguage: z.enum(["CHINESE", "ENGLISH"]).optional(),
  modelId: z.string().uuid().optional(),
});

/** 聊天 AI 只提供显式、无副作用的转换操作，不修改或发送任何原消息。 */
export function createMessageAiRouter() {
  const router = Router();

  router.post("/messages/:messageId/ai-actions", authenticate, async (request, response) => {
    if (!getAiCapabilities().features.messageActions) {
      throw new ApiError(503, "聊天 AI 快捷处理尚未就绪，现有消息功能不受影响");
    }
    const input = actionSchema.parse(request.body);
    const result = await runMessageAiAction({
      userId: currentUser(request).id,
      messageId: idSchema.parse(request.params.messageId),
      action: input.action,
      targetLanguage: input.targetLanguage,
      modelId: input.modelId,
    });
    response.json(result);
  });

  return router;
}
