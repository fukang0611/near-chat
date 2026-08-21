import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./http.js";
import {
  assistantMessageState,
  assistantState,
  memoryState,
  parseSyncEntityPayload,
} from "./sync-entity-adapter.js";

test("记忆与助理消息同步 payload 使用 camelCase 且丢弃权威字段", () => {
  assert.deepEqual(
    parseSyncEntityPayload("MEMORY", {
      id: "00000000-0000-4000-8000-000000000001",
      tier: "LONG_TERM",
      scope: "PRIVATE",
      conversationId: null,
      kind: "NOTE",
      title: "  发布口径  ",
      content: "以正式通知为准",
      importance: 4,
      status: "ACTIVE",
      revision: 8,
      expiresAt: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      deletedAt: null,
      ownerId: "不应信任",
    }),
    {
      tier: "LONG_TERM",
      scope: "PRIVATE",
      conversationId: null,
      kind: "NOTE",
      title: "发布口径",
      content: "以正式通知为准",
      importance: 4,
      status: "ACTIVE",
      expiresAt: null,
    },
  );

  assert.deepEqual(
    parseSyncEntityPayload("ASSISTANT_MESSAGE", {
      id: "00000000-0000-4000-8000-000000000002",
      assistantId: "00000000-0000-4000-8000-000000000003",
      threadId: "00000000-0000-4000-8000-000000000004",
      role: "USER",
      content: "  帮我整理  ",
      modelId: null,
      sources: [],
      revision: 9,
      createdAt: "2020-01-01T00:00:00.000Z",
    }),
    {
      assistantId: "00000000-0000-4000-8000-000000000003",
      threadId: "00000000-0000-4000-8000-000000000004",
      role: "USER",
      content: "帮我整理",
      modelId: null,
      sources: [],
    },
  );
});

test("移动同步拒绝把团队会话记忆复制到离线私人记忆库", () => {
  assert.throws(
    () =>
      parseSyncEntityPayload("MEMORY", {
        tier: "LONG_TERM",
        scope: "CONVERSATION",
        conversationId: "00000000-0000-4000-8000-000000000001",
        kind: "NOTE",
        title: "团队会议结论",
        content: "只应在有会话权限时查看",
        importance: 3,
        status: "ACTIVE",
        expiresAt: null,
      }),
    /Invalid literal value|Invalid input/,
  );
});

test("已删除记忆的同步投影只包含定位、版本和删除时间", () => {
  const deletedAt = new Date("2026-08-21T02:03:04.000Z");
  const state = memoryState({
    id: "00000000-0000-4000-8000-000000000011",
    tier: "LONG_TERM",
    scope: "PRIVATE",
    conversation_id: null,
    kind: "NOTE",
    title: "不应进入 tombstone 的标题",
    content: "不应进入 tombstone 的正文",
    importance: 5,
    status: "DELETED",
    revision: 3,
    expires_at: null,
    deleted_at: deletedAt,
    created_at: new Date("2026-08-20T00:00:00.000Z"),
    updated_at: deletedAt,
  });
  assert.equal(state.deleted, true);
  assert.deepEqual(state.payload, {
    id: "00000000-0000-4000-8000-000000000011",
    revision: 3,
    deletedAt: "2026-08-21T02:03:04.000Z",
  });
});

test("助理检索授权只从服务端投影下发，移动回推不能扩大授权", () => {
  assert.deepEqual(
    parseSyncEntityPayload("ASSISTANT", {
      name: "本地助理",
      description: "",
      category: "GENERAL",
      instructions: "回答简洁",
      avatarColor: "#6757E8",
      modelId: null,
      toolGrants: {
        crossConversationSearch: true,
        privateMemoryRead: true,
      },
    }),
    {
      name: "本地助理",
      description: "",
      category: "GENERAL",
      instructions: "回答简洁",
      avatarColor: "#6757E8",
      modelId: null,
    },
  );

  const state = assistantState({
    id: "00000000-0000-4000-8000-000000000101",
    name: "服务端助理",
    description: "",
    category: "GENERAL",
    instructions: "回答简洁",
    avatar_color: "#6757E8",
    model_id: null,
    cross_conversation_search: false,
    private_memory_read: true,
    revision: 3,
    deleted_at: null,
    created_at: new Date("2026-08-21T00:00:00.000Z"),
    updated_at: new Date("2026-08-21T01:00:00.000Z"),
  });
  assert.deepEqual(state.payload.toolGrants, {
    crossConversationSearch: false,
    privateMemoryRead: true,
  });
});

test("投影遗留超限助理消息时返回可诊断 413 而不生成不可传输 snapshot", () => {
  assert.throws(
    () =>
      assistantMessageState({
        id: "00000000-0000-4000-8000-000000000501",
        assistant_id: "00000000-0000-4000-8000-000000000502",
        thread_id: "00000000-0000-4000-8000-000000000503",
        role: "ASSISTANT",
        content: "x".repeat(50_001),
        model_id: "00000000-0000-4000-8000-000000000504",
        sources: [],
        revision: 1,
        deleted_at: null,
        created_at: new Date("2026-08-21T00:00:00.000Z"),
      }),
    (error) =>
      error instanceof ApiError &&
      error.status === 413 &&
      error.message.includes("00000000-0000-4000-8000-000000000501无法跨端同步"),
  );
});
