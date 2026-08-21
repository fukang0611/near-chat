import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { currentUser } from "../http.js";
import {
  acceptMemoryCandidate,
  createManualMemory,
  createMessageMemoryCandidate,
  forgetMemory,
  getMemorySettings,
  listMemories,
  listMemoryCandidates,
  rejectMemoryCandidate,
  updateMemory,
  updateMemorySettings,
} from "../memory-service.js";

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
const memoryTiers = ["SHORT_TERM", "LONG_TERM"] as const;

const memoryFields = {
  title: z.string().trim().min(1, "请填写记忆标题").max(120),
  content: z.string().trim().min(1, "请填写记忆内容").max(10_000),
  kind: z.enum(memoryKinds),
  importance: z.number().int().min(1).max(5),
};

const listMemorySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(memoryKinds).optional(),
  tier: z.enum(memoryTiers).default("LONG_TERM"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const createMemorySchema = z.object({ ...memoryFields, tier: z.enum(memoryTiers).optional() });
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
const forgetMemorySchema = z.object({ baseRevision: z.number().int().positive() });

/** 记忆接口不经过 AI 能力开关，模型未配置时仍然完整可用。 */
export function createMemoryRouter() {
  const router = Router();

  router.get("/memories", authenticate, async (request, response) => {
    const input = listMemorySchema.parse(request.query);
    response.json(
      await listMemories(currentUser(request).id, {
        keyword: input.q || undefined,
        kind: input.kind,
        tier: input.tier,
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
    await forgetMemory(
      currentUser(request).id,
      z.string().uuid().parse(request.params.memoryId),
      forgetMemorySchema.parse(request.body).baseRevision,
    );
    response.status(204).end();
  });

  router.get("/memory-candidates", authenticate, async (request, response) => {
    response.json(await listMemoryCandidates(currentUser(request).id));
  });

  router.post("/messages/:messageId/memory-candidate", authenticate, async (request, response) => {
    const result = await createMessageMemoryCandidate(
      currentUser(request).id,
      z.string().uuid().parse(request.params.messageId),
    );
    response.status(result.created ? 201 : 200).json(result);
  });

  router.post("/memory-candidates/:candidateId/accept", authenticate, async (request, response) => {
    const { tier } = z.object({ tier: z.enum(memoryTiers) }).parse(request.body);
    const memory = await acceptMemoryCandidate(
      currentUser(request).id,
      z.string().uuid().parse(request.params.candidateId),
      tier,
    );
    response.status(201).json({ memory });
  });

  router.delete("/memory-candidates/:candidateId", authenticate, async (request, response) => {
    await rejectMemoryCandidate(
      currentUser(request).id,
      z.string().uuid().parse(request.params.candidateId),
    );
    response.status(204).end();
  });

  router.get("/memory-settings", authenticate, async (request, response) => {
    response.json({ settings: await getMemorySettings(currentUser(request).id) });
  });

  router.patch("/memory-settings", authenticate, async (request, response) => {
    const input = z
      .object({
        explicitCaptureEnabled: z.boolean().optional(),
        semanticCaptureEnabled: z.boolean().optional(),
      })
      .refine(
        (value) =>
          value.explicitCaptureEnabled !== undefined || value.semanticCaptureEnabled !== undefined,
        "至少修改一项记忆设置",
      )
      .parse(request.body);
    response.json({
      settings: await updateMemorySettings(currentUser(request).id, input),
    });
  });

  return router;
}
