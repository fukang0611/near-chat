import assert from "node:assert/strict";
import test from "node:test";
import type { LocalAssistant, LocalMemory } from "../src/models.ts";
import { prepareAssistantMemoryAugmentation } from "../src/assistant-memory-context.ts";
import { createDefaultAssistantWorkspace } from "../src/assistant-defaults.ts";

function assistant(privateMemoryRead: boolean): LocalAssistant {
  return {
    id: "assistant-1",
    name: "测试助理",
    description: "",
    category: "GENERAL",
    instructions: "只依据获准的上下文回答",
    avatarColor: "#6757E8",
    modelId: null,
    toolGrants: { crossConversationSearch: false, privateMemoryRead },
    revision: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

const secretMemory: LocalMemory = {
  id: "memory-secret",
  tier: "LONG_TERM",
  scope: "PRIVATE",
  conversationId: null,
  kind: "NOTE",
  title: "私人暗号",
  content: "绝密内容-7349",
  importance: 5,
  status: "ACTIVE",
  revision: 1,
  expiresAt: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  deletedAt: null,
};

test("本地默认助理的检索授权显式为 false", () => {
  const workspace = createDefaultAssistantWorkspace("2026-08-21T00:00:00.000Z", () => "local-id");
  assert.deepEqual(workspace.assistant.toolGrants, {
    crossConversationSearch: false,
    privateMemoryRead: false,
  });
});

test("未授权助理不会执行私人记忆检索，也不会把私人内容交给模型", async () => {
  let searches = 0;
  const result = await prepareAssistantMemoryAugmentation(assistant(false), async () => {
    searches += 1;
    return { output: [secretMemory] };
  });

  assert.equal(searches, 0);
  assert.equal(result.allowPrivateMemory, false);
  assert.deepEqual(result.memories, []);
  assert.deepEqual(result.sourceIds, []);
  assert.deepEqual(result.sources, []);
  assert.doesNotMatch(result.instructions, /绝密内容-7349/);
});

test("只有明确授权后才执行私人记忆检索并附加可追溯上下文", async () => {
  let searches = 0;
  const result = await prepareAssistantMemoryAugmentation(assistant(true), async () => {
    searches += 1;
    return { output: [secretMemory] };
  });

  assert.equal(searches, 1);
  assert.equal(result.allowPrivateMemory, true);
  assert.match(result.instructions, /绝密内容-7349/);
  assert.deepEqual(result.sourceIds, ["memory-secret"]);
  assert.deepEqual(result.sources, [{ type: "MEMORY", id: "memory-secret", title: "私人暗号" }]);
});
