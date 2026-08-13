import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { currentUser } from "../http.js";
import { listChatFiles } from "../message-assets-service.js";

const fileLibraryQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(["ALL", "IMAGE", "AUDIO", "FILE"]).default("ALL"),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** 消息资产中心：集中提供聊天文件与后续收藏能力。 */
export function createMessageAssetsRouter() {
  const router = Router();

  router.get("/message-assets/files", authenticate, async (request, response) => {
    const user = currentUser(request);
    const input = fileLibraryQuerySchema.parse(request.query);
    const page = await listChatFiles(user.id, {
      keyword: input.q || undefined,
      category: input.category,
      conversationId: input.conversationId,
      limit: input.limit,
      offset: input.offset,
    });
    response.json(page);
  });

  return router;
}
