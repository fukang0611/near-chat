import { Router } from "express";
import { z } from "zod";
import { getAiCapabilities } from "../ai/ai-runtime.js";
import {
  clearAiAssistantMessages,
  createAiAssistant,
  deleteAiAssistant,
  listAiAssistantMessages,
  listAiAssistants,
  sendAiAssistantMessage,
  updateAiAssistant,
} from "../assistant/assistant-service.js";
import { authenticate } from "../auth.js";
import { ApiError, currentUser } from "../http.js";

const idSchema = z.string().uuid();
const categorySchema = z.enum(["GENERAL", "WRITING", "ANALYSIS", "PLANNING"]);
const avatarColorSchema = z.string().regex(/^#[0-9A-F]{6}$/i, "头像颜色格式不正确");
const knowledgeBaseIdsSchema = z
  .array(z.string().uuid())
  .max(10, "一个助理最多绑定 10 个知识库")
  .refine((ids) => new Set(ids).size === ids.length, "知识库不能重复绑定");

const assistantFields = {
  name: z.string().trim().min(1, "请输入助理名称").max(80, "助理名称不能超过 80 个字"),
  description: z.string().trim().max(240, "简介不能超过 240 个字"),
  category: categorySchema,
  instructions: z
    .string()
    .trim()
    .min(1, "请输入助理的角色说明")
    .max(6000, "角色说明不能超过 6000 个字"),
  avatarColor: avatarColorSchema,
  modelId: z.union([z.string().uuid(), z.null()]),
  knowledgeBaseIds: knowledgeBaseIdsSchema,
};

const createAssistantSchema = z.object(assistantFields);
const updateAssistantSchema = z
  .object({
    name: assistantFields.name.optional(),
    description: assistantFields.description.optional(),
    category: assistantFields.category.optional(),
    instructions: assistantFields.instructions.optional(),
    avatarColor: assistantFields.avatarColor.optional(),
    modelId: assistantFields.modelId.optional(),
    knowledgeBaseIds: assistantFields.knowledgeBaseIds.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "没有需要更新的内容");
const sendMessageSchema = z.object({
  content: z.string().trim().min(1, "请输入消息").max(4000, "消息不能超过 4000 个字"),
});

function requirePersonalAssistants(): void {
  if (!getAiCapabilities().features.personalAssistants) {
    throw new ApiError(503, "个人助理尚未就绪，请检查 AI 对话模型配置");
  }
}

/** 个人助理属于当前用户的私有空间，不复用团队会话与消息表。 */
export function createAssistantRouter() {
  const router = Router();

  router.get("/ai/assistants", authenticate, async (request, response) => {
    requirePersonalAssistants();
    response.json({ assistants: await listAiAssistants(currentUser(request).id) });
  });

  router.post("/ai/assistants", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const assistant = await createAiAssistant(
      currentUser(request).id,
      createAssistantSchema.parse(request.body),
    );
    response.status(201).json({ assistant });
  });

  router.patch("/ai/assistants/:assistantId", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const assistant = await updateAiAssistant(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
      updateAssistantSchema.parse(request.body),
    );
    response.json({ assistant });
  });

  router.delete("/ai/assistants/:assistantId", authenticate, async (request, response) => {
    requirePersonalAssistants();
    await deleteAiAssistant(currentUser(request).id, idSchema.parse(request.params.assistantId));
    response.status(204).end();
  });

  router.get("/ai/assistants/:assistantId/messages", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const messages = await listAiAssistantMessages(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
    );
    response.json({ messages });
  });

  router.delete("/ai/assistants/:assistantId/messages", authenticate, async (request, response) => {
    requirePersonalAssistants();
    await clearAiAssistantMessages(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
    );
    response.status(204).end();
  });

  router.post("/ai/assistants/:assistantId/messages", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const input = sendMessageSchema.parse(request.body);
    const messages = await sendAiAssistantMessage(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
      input.content,
    );
    response.status(201).json({ messages });
  });

  return router;
}
