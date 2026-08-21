import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceGeneratedAssistantMessage } from "../src/assistant-messages.ts";

test("端侧模型回复不会冒充同步助理配置中的服务端 modelId", () => {
  const reply = createDeviceGeneratedAssistantMessage({
    id: "message-1",
    assistantId: "assistant-with-server-model-uuid",
    threadId: "thread-1",
    content: "由设备配置的 local-model 生成",
    sources: [],
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(reply.modelId, null);
  assert.equal(reply.role, "ASSISTANT");
});
