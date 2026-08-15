import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { currentUser } from "../http.js";
import { createManualMemory, forgetMemory, listMemories, updateMemory } from "../memory-service.js";

const memoryKinds = [
  "PREFERENCE",
  "PERSON",
  "PROJECT",
  "DECISION",
  "PROCEDURE",
  "GOAL",
  "NOTE",
  "TASK_CONTEXT",
] as const;

const memoryFields = {
  title: z.string().trim().min(1, "请填写记忆标题").max(120),
  content: z.string().trim().min(1, "请填写记忆内容").max(10_000),
  kind: z.enum(memoryKinds),
  importance: z.number().int().min(1).max(5),
};

const listMemorySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(memoryKinds).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const createMemorySchema = z.object(memoryFields);
const updateMemorySchema = z
  .object({
    title: memoryFields.title.optional(),
    content: memoryFields.content.optional(),
    kind: memoryFields.kind.optional(),
    importance: memoryFields.importance.optional(),
    baseRevision: z.number().int().positive(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.content !== undefined ||
      input.kind !== undefined ||
      input.importance !== undefined,
    { message: "至少修改一个记忆字段" },
  );

/** 长期记忆接口不经过 AI 能力开关，模型未配置时仍然完整可用。 */
export function createMemoryRouter() {
  const router = Router();

  router.get("/memories", authenticate, async (request, response) => {
    const input = listMemorySchema.parse(request.query);
    response.json(
      await listMemories(currentUser(request).id, {
        keyword: input.q || undefined,
        kind: input.kind,
        limit: input.limit,
        offset: input.offset,
      }),
    );
  });

  router.post("/memories", authenticate, async (request, response) => {
    const memory = await createManualMemory(
      currentUser(request).id,
      createMemorySchema.parse(request.body),
    );
    response.status(201).json({ memory });
  });

  router.patch("/memories/:memoryId", authenticate, async (request, response) => {
    const memory = await updateMemory(
      currentUser(request).id,
      z.string().uuid().parse(request.params.memoryId),
      updateMemorySchema.parse(request.body),
    );
    response.json({ memory });
  });

  router.delete("/memories/:memoryId", authenticate, async (request, response) => {
    await forgetMemory(currentUser(request).id, z.string().uuid().parse(request.params.memoryId));
    response.status(204).end();
  });

  return router;
}
