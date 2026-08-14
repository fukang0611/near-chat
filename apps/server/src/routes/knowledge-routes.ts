import { Router } from "express";
import { z } from "zod";
import { getAiCapabilities } from "../ai/ai-runtime.js";
import {
  listUserAiModels,
  resolveUserAiModelId,
  setUserAiModel,
} from "../ai/ai-settings-service.js";
import { authenticate } from "../auth.js";
import { ApiError, currentUser } from "../http.js";
import {
  addKnowledgeDocument,
  askKnowledge,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  listKnowledgeBases,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  searchKnowledge,
  updateKnowledgeBase,
} from "../knowledge/knowledge-service.js";

const idSchema = z.string().uuid();
const createBaseSchema = z.object({
  name: z.string().trim().min(1, "请输入知识库名称").max(80, "知识库名称不能超过 80 个字"),
  description: z.string().trim().max(240, "说明不能超过 240 个字").default(""),
});
const updateBaseSchema = z
  .object({
    name: z.string().trim().min(1, "请输入知识库名称").max(80).optional(),
    description: z.string().trim().max(240).optional(),
  })
  .refine((input) => input.name !== undefined || input.description !== undefined, {
    message: "没有需要更新的内容",
  });
const documentSchema = z.object({ attachmentId: z.string().uuid() });
const searchSchema = z.object({
  query: z.string().trim().min(1, "请输入检索内容").max(1000, "检索内容过长"),
  topK: z.number().int().min(1).max(20).optional(),
});
const askSchema = z.object({
  question: z.string().trim().min(1, "请输入问题").max(2000, "问题内容过长"),
  modelId: z.string().uuid().optional(),
});
const preferenceSchema = z.object({ modelId: z.union([z.string().uuid(), z.null()]) });

function requireKnowledgeManagement(): void {
  if (!getAiCapabilities().features.knowledgeManagement) {
    throw new ApiError(503, "AI 增强能力未启用，现有聊天功能不受影响");
  }
}

/** 原生知识库 API：NearChat 负责用户权限、文件来源与任务状态，Mastra 负责 RAG。 */
export function createKnowledgeRouter() {
  const router = Router();

  router.get("/ai/capabilities", authenticate, (_request, response) => {
    response.json({ capabilities: getAiCapabilities() });
  });

  router.get("/ai/models", authenticate, async (request, response) => {
    response.json(await listUserAiModels(currentUser(request).id));
  });

  router.put("/ai/preferences/model", authenticate, async (request, response) => {
    const input = preferenceSchema.parse(request.body);
    const user = currentUser(request);
    await setUserAiModel(user.id, input.modelId);
    response.json(await listUserAiModels(user.id));
  });

  router.get("/knowledge-bases", authenticate, async (request, response) => {
    requireKnowledgeManagement();
    const bases = await listKnowledgeBases(currentUser(request).id);
    response.json({ knowledgeBases: bases });
  });

  router.post("/knowledge-bases", authenticate, async (request, response) => {
    requireKnowledgeManagement();
    const input = createBaseSchema.parse(request.body);
    const knowledgeBase = await createKnowledgeBase(currentUser(request).id, input);
    response.status(201).json({ knowledgeBase });
  });

  router.patch("/knowledge-bases/:knowledgeBaseId", authenticate, async (request, response) => {
    requireKnowledgeManagement();
    const knowledgeBaseId = idSchema.parse(request.params.knowledgeBaseId);
    const input = updateBaseSchema.parse(request.body);
    const knowledgeBase = await updateKnowledgeBase(
      currentUser(request).id,
      knowledgeBaseId,
      input,
    );
    response.json({ knowledgeBase });
  });

  router.delete("/knowledge-bases/:knowledgeBaseId", authenticate, async (request, response) => {
    requireKnowledgeManagement();
    await deleteKnowledgeBase(
      currentUser(request).id,
      idSchema.parse(request.params.knowledgeBaseId),
    );
    response.status(204).end();
  });

  router.get(
    "/knowledge-bases/:knowledgeBaseId/documents",
    authenticate,
    async (request, response) => {
      requireKnowledgeManagement();
      const documents = await listKnowledgeDocuments(
        currentUser(request).id,
        idSchema.parse(request.params.knowledgeBaseId),
      );
      response.json({ documents });
    },
  );

  router.post(
    "/knowledge-bases/:knowledgeBaseId/documents",
    authenticate,
    async (request, response) => {
      requireKnowledgeManagement();
      const input = documentSchema.parse(request.body);
      const document = await addKnowledgeDocument(
        currentUser(request).id,
        idSchema.parse(request.params.knowledgeBaseId),
        input.attachmentId,
      );
      response.status(201).json({ document });
    },
  );

  router.post(
    "/knowledge-bases/:knowledgeBaseId/documents/:documentId/reindex",
    authenticate,
    async (request, response) => {
      requireKnowledgeManagement();
      await reindexKnowledgeDocument(
        currentUser(request).id,
        idSchema.parse(request.params.knowledgeBaseId),
        idSchema.parse(request.params.documentId),
      );
      response.status(202).json({ queued: true });
    },
  );

  router.delete(
    "/knowledge-bases/:knowledgeBaseId/documents/:documentId",
    authenticate,
    async (request, response) => {
      requireKnowledgeManagement();
      await deleteKnowledgeDocument(
        currentUser(request).id,
        idSchema.parse(request.params.knowledgeBaseId),
        idSchema.parse(request.params.documentId),
      );
      response.status(204).end();
    },
  );

  router.post(
    "/knowledge-bases/:knowledgeBaseId/search",
    authenticate,
    async (request, response) => {
      requireKnowledgeManagement();
      const input = searchSchema.parse(request.body);
      const result = await searchKnowledge(
        currentUser(request).id,
        idSchema.parse(request.params.knowledgeBaseId),
        input.query,
        input.topK,
      );
      response.json(result);
    },
  );

  router.post("/knowledge-bases/:knowledgeBaseId/ask", authenticate, async (request, response) => {
    requireKnowledgeManagement();
    const input = askSchema.parse(request.body);
    const user = currentUser(request);
    const modelId = await resolveUserAiModelId(user.id, input.modelId);
    if (!modelId) throw new ApiError(503, "当前没有可用的对话模型");
    const result = await askKnowledge(
      user.id,
      idSchema.parse(request.params.knowledgeBaseId),
      input.question,
      modelId,
    );
    response.json(result);
  });

  return router;
}
