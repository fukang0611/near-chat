import { Router } from "express";
import { z } from "zod";
import {
  confirmAssistantInvocation,
  dismissAssistantInvocation,
  listAssistantInvocations,
} from "../assistant/assistant-invocation-service.js";
import { authenticate } from "../auth.js";
import { query } from "../database.js";
import { currentUser } from "../http.js";
import { observeConversationMessageForMemory } from "../memory-capture-service.js";
import { broadcastReceiptChanges, markMessageDelivered } from "../receipt-service.js";
import { RealtimeHub } from "../realtime.js";

const idSchema = z.string().uuid();

async function conversationMemberIds(conversationId: string): Promise<string[]> {
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId],
  );
  return result.rows.map((row) => row.user_id);
}

/** 私有预览接口与普通消息接口分离，避免把模型结果意外广播给会话成员。 */
export function createAssistantInvocationRouter(realtime: RealtimeHub): Router {
  const router = Router();

  router.get(
    "/conversations/:conversationId/assistant-invocations",
    authenticate,
    async (request, response) => {
      const invocations = await listAssistantInvocations(
        currentUser(request).id,
        idSchema.parse(request.params.conversationId),
      );
      response.json({ invocations });
    },
  );

  router.post(
    "/assistant-invocations/:invocationId/dismiss",
    authenticate,
    async (request, response) => {
      const invocation = await dismissAssistantInvocation(
        currentUser(request).id,
        idSchema.parse(request.params.invocationId),
      );
      response.json({ invocation });
    },
  );

  router.post(
    "/assistant-invocations/:invocationId/confirm",
    authenticate,
    async (request, response) => {
      const result = await confirmAssistantInvocation(
        currentUser(request).id,
        idSchema.parse(request.params.invocationId),
      );
      let message = result.message;
      if (result.created) {
        const members = await conversationMemberIds(message.conversationId);
        const deliveredUsers = realtime
          .sendToUsers(members, { type: "message.created", payload: { message } })
          .filter((memberId) => memberId !== currentUser(request).id);
        const receiptChanges = await markMessageDelivered(message.id, deliveredUsers);
        await broadcastReceiptChanges(realtime, receiptChanges);
        if (receiptChanges[0]) message = { ...message, receipt: receiptChanges[0].receipt };
        void observeConversationMessageForMemory(message.conversationId, message.id).catch(
          (error) => console.warn("Failed to queue assistant reply memory observation:", error),
        );
      }
      response.status(result.created ? 201 : 200).json({ message });
    },
  );

  return router;
}
