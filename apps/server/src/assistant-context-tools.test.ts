import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolContext } from "@near-chat/contracts";
import {
  AssistantContextCollector,
  compactAssistantSourceExcerpt,
  contextToolAvailability,
  escapeAssistantSearchPattern,
} from "./assistant/assistant-context-tools.js";

const privateContext: AgentToolContext = {
  requesterUserId: "user-1",
  assistantId: "assistant-1",
  invocationId: "invocation-1",
  visibility: "PRIVATE_PREVIEW",
  allowedConversationIds: ["conversation-1"],
  allowPrivateMemory: true,
};

test("助理检索转义通配符并压缩过长来源", () => {
  assert.equal(escapeAssistantSearchPattern("计划_100%\\完成"), "计划\\_100\\%\\\\完成");
  const excerpt = compactAssistantSourceExcerpt(`  ${"发布  ".repeat(200)} `);
  assert.ok(excerpt.length <= 420);
  assert.match(excerpt, /…$/u);
});

test("公开回复不会挂载跨会话和私人记忆工具", () => {
  assert.deepEqual(contextToolAvailability(privateContext), { chat: true, memory: true });
  assert.deepEqual(
    contextToolAvailability({ ...privateContext, visibility: "CONVERSATION_REPLY" }),
    { chat: false, memory: false },
  );
});

test("上下文来源去重并生成稳定引用编号", () => {
  const collector = new AssistantContextCollector();
  const source = {
    type: "MESSAGE" as const,
    id: "message-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    label: "项目群 · 林小满",
    excerpt: "周五发布",
    createdAt: "2026-08-15T08:00:00.000Z",
  };
  assert.equal(collector.add(source).citation, "聊天1");
  assert.equal(collector.add(source).citation, "聊天1");
  assert.equal(
    collector.add({ ...source, type: "MEMORY", id: "memory-1", messageId: null }).citation,
    "记忆1",
  );
  assert.equal(collector.values().length, 2);
});
