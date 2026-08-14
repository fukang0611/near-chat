import { Router } from "express";
import { z } from "zod";
import { getAiCapabilities } from "../ai/ai-runtime.js";
import {
  confirmAiAssistantBrowserStep,
  createAiAssistantBrowserRun,
  deleteAiAssistantBrowserRun,
  finishAiAssistantBrowserRun,
  getAiAssistantBrowserPermission,
  listAiAssistantBrowserRuns,
  prepareAiAssistantBrowserStep,
  updateAiAssistantBrowserPermission,
} from "../assistant/assistant-browser-service.js";
import {
  ASSISTANT_MESSAGE_FILE_LIMIT,
  addAiAssistantFile,
  listAiAssistantFiles,
  removeAiAssistantFile,
  saveAssistantMessageAsFile,
} from "../assistant/assistant-file-service.js";
import {
  clearAiAssistantMessages,
  createAiAssistant,
  deleteAiAssistant,
  listAiAssistantMessages,
  listAiAssistants,
  sendAiAssistantMessage,
  updateAiAssistant,
} from "../assistant/assistant-service.js";
import {
  createAiAssistantTask,
  deleteAiAssistantTask,
  listAiAssistantTasks,
  requestAiAssistantTaskRun,
  updateAiAssistantTask,
} from "../assistant/assistant-task-service.js";
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
  fileIds: z
    .array(idSchema)
    .max(ASSISTANT_MESSAGE_FILE_LIMIT, `每次最多引用 ${ASSISTANT_MESSAGE_FILE_LIMIT} 个文件`)
    .refine((ids) => new Set(ids).size === ids.length, "引用文件不能重复")
    .default([]),
});
const addAssistantFileSchema = z.object({
  attachmentId: idSchema,
  origin: z.enum(["CHAT", "UPLOAD"]),
});
const saveAssistantMessageFileSchema = z.object({
  format: z.enum(["MARKDOWN", "TEXT"]),
  name: z.string().trim().max(180, "文件名不能超过 180 个字").optional(),
});
const browserPermissionSchema = z.object({
  enabled: z.boolean(),
  allowScreenshot: z.boolean(),
  allowInteraction: z.boolean(),
});
const createBrowserRunSchema = z.object({
  goal: z.string().trim().min(1, "请输入本次浏览目标").max(500, "浏览目标不能超过 500 个字"),
  startUrl: z.string().trim().min(1, "请输入页面地址").max(2048, "页面地址过长"),
});
const createBrowserStepSchema = z
  .object({
    action: z.enum(["READ", "SCREENSHOT", "CLICK", "FILL"]),
    elementRef: z.string().trim().optional(),
  })
  .superRefine((input, context) => {
    if ((input.action === "CLICK" || input.action === "FILL") && !input.elementRef) {
      context.addIssue({ code: "custom", message: "请选择要操作的页面元素" });
    }
  });
const confirmBrowserStepSchema = z.object({
  value: z.string().max(2000, "单次填写不能超过 2000 个字").optional(),
});
const finishBrowserRunSchema = z.object({
  outcome: z.enum(["SUCCEEDED", "CANCELLED"]),
});
const scheduledForSchema = z
  .string()
  .datetime({ offset: true, message: "执行时间格式不正确" })
  .transform((value) => new Date(value));
const taskFields = {
  title: z.string().trim().min(1, "请输入任务名称").max(80, "任务名称不能超过 80 个字"),
  prompt: z.string().trim().min(1, "请输入任务内容").max(6000, "任务内容不能超过 6000 个字"),
  scheduleType: z.enum(["ONCE", "DAILY", "WEEKLY"]),
  scheduledFor: scheduledForSchema,
  enabled: z.boolean(),
  fileIds: z.array(idSchema).max(5, "每个任务最多选择 5 个文件").default([]),
  browserAction: z.enum(["NONE", "READ", "SCREENSHOT"]).default("NONE"),
  browserUrl: z.string().trim().max(2048, "页面地址过长").nullable().default(null),
};
const createTaskSchema = z.object(taskFields).superRefine((input, context) => {
  if (input.browserAction !== "NONE" && !input.browserUrl) {
    context.addIssue({ code: "custom", path: ["browserUrl"], message: "请输入目标页面地址" });
  }
});
const updateTaskSchema = z
  .object({
    title: taskFields.title.optional(),
    prompt: taskFields.prompt.optional(),
    scheduleType: taskFields.scheduleType.optional(),
    scheduledFor: taskFields.scheduledFor.optional(),
    enabled: taskFields.enabled.optional(),
    fileIds: taskFields.fileIds.optional(),
    browserAction: taskFields.browserAction.optional(),
    browserUrl: taskFields.browserUrl.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "没有需要更新的内容");

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
      input.fileIds,
    );
    response.status(201).json({ messages });
  });

  router.get("/ai/assistants/:assistantId/files", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const files = await listAiAssistantFiles(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
    );
    response.json({ files });
  });

  router.post("/ai/assistants/:assistantId/files", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const input = addAssistantFileSchema.parse(request.body);
    const file = await addAiAssistantFile(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
      input.attachmentId,
      input.origin,
    );
    response.status(201).json({ file });
  });

  router.delete(
    "/ai/assistants/:assistantId/files/:fileId",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      await removeAiAssistantFile(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.fileId),
      );
      response.status(204).end();
    },
  );

  router.post(
    "/ai/assistants/:assistantId/messages/:messageId/file",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const input = saveAssistantMessageFileSchema.parse(request.body);
      const file = await saveAssistantMessageAsFile({
        userId: currentUser(request).id,
        assistantId: idSchema.parse(request.params.assistantId),
        messageId: idSchema.parse(request.params.messageId),
        format: input.format,
        name: input.name,
      });
      response.status(201).json({ file });
    },
  );

  router.get(
    "/ai/assistants/:assistantId/browser/permission",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const permission = await getAiAssistantBrowserPermission(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
      );
      response.json({ permission });
    },
  );

  router.put(
    "/ai/assistants/:assistantId/browser/permission",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const permission = await updateAiAssistantBrowserPermission(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        browserPermissionSchema.parse(request.body),
      );
      response.json({ permission });
    },
  );

  router.get(
    "/ai/assistants/:assistantId/browser/runs",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const runs = await listAiAssistantBrowserRuns(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
      );
      response.json({ runs });
    },
  );

  router.post(
    "/ai/assistants/:assistantId/browser/runs",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const input = createBrowserRunSchema.parse(request.body);
      const run = await createAiAssistantBrowserRun(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        input.goal,
        input.startUrl,
      );
      response.status(201).json({ run });
    },
  );

  router.post(
    "/ai/assistants/:assistantId/browser/runs/:runId/steps",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const run = await prepareAiAssistantBrowserStep(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.runId),
        createBrowserStepSchema.parse(request.body),
      );
      response.status(201).json({ run });
    },
  );

  router.post(
    "/ai/assistants/:assistantId/browser/runs/:runId/steps/:stepId/confirm",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const input = confirmBrowserStepSchema.parse(request.body);
      const run = await confirmAiAssistantBrowserStep(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.runId),
        idSchema.parse(request.params.stepId),
        input.value,
      );
      response.json({ run });
    },
  );

  router.post(
    "/ai/assistants/:assistantId/browser/runs/:runId/finish",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const input = finishBrowserRunSchema.parse(request.body);
      const run = await finishAiAssistantBrowserRun(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.runId),
        input.outcome,
      );
      response.json({ run });
    },
  );

  router.delete(
    "/ai/assistants/:assistantId/browser/runs/:runId",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      await deleteAiAssistantBrowserRun(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.runId),
      );
      response.status(204).end();
    },
  );

  router.get("/ai/assistants/:assistantId/tasks", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const tasks = await listAiAssistantTasks(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
    );
    response.json({ tasks });
  });

  router.post("/ai/assistants/:assistantId/tasks", authenticate, async (request, response) => {
    requirePersonalAssistants();
    const task = await createAiAssistantTask(
      currentUser(request).id,
      idSchema.parse(request.params.assistantId),
      createTaskSchema.parse(request.body),
    );
    response.status(201).json({ task });
  });

  router.patch(
    "/ai/assistants/:assistantId/tasks/:taskId",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const task = await updateAiAssistantTask(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.taskId),
        updateTaskSchema.parse(request.body),
      );
      response.json({ task });
    },
  );

  router.delete(
    "/ai/assistants/:assistantId/tasks/:taskId",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      await deleteAiAssistantTask(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.taskId),
      );
      response.status(204).end();
    },
  );

  router.post(
    "/ai/assistants/:assistantId/tasks/:taskId/run",
    authenticate,
    async (request, response) => {
      requirePersonalAssistants();
      const task = await requestAiAssistantTaskRun(
        currentUser(request).id,
        idSchema.parse(request.params.assistantId),
        idSchema.parse(request.params.taskId),
      );
      response.status(202).json({ task });
    },
  );

  return router;
}
