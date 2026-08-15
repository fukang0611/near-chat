import assert from "node:assert/strict";
import pg from "pg";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://near_chat:near_chat@127.0.0.1:15432/near_chat";
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function request(path, { token, method = "GET", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${result?.message ?? "未知错误"}`,
    );
  }
  return result;
}

const suffix = Date.now().toString(36);
const chatMarker = `ORBIT_CHAT_${suffix}`;
const memoryMarker = `ORBIT_MEMORY_${suffix}`;
let token;
let groupId;
let memoryId;
let assistantId;

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password },
  });
  token = login.token;
  const users = (await request("/api/users", { token })).users.filter(
    (user) => user.id !== login.user.id,
  );
  assert.ok(users.length >= 2, "跨会话检索验收需要至少两位演示联系人");

  groupId = (
    await request("/api/conversations/groups", {
      token,
      method: "POST",
      body: {
        name: `助理检索验收-${suffix}`,
        memberIds: users.slice(0, 2).map((user) => user.id),
      },
    })
  ).conversationId;
  const message = (
    await request(`/api/conversations/${groupId}/messages`, {
      token,
      method: "POST",
      body: {
        clientMessageId: crypto.randomUUID(),
        text: `${chatMarker}：团队决定在周五 16:30 完成内部发布。`,
        attachmentIds: [],
      },
    })
  ).message;

  const memory = (
    await request("/api/memories", {
      token,
      method: "POST",
      body: {
        title: `验收偏好 ${memoryMarker}`,
        content: `${memoryMarker}：用户偏好先给结论，再列三条行动。`,
        kind: "PREFERENCE",
        importance: 5,
        tier: "LONG_TERM",
      },
    })
  ).memory;
  memoryId = memory.id;

  const created = await request("/api/ai/assistants", {
    token,
    method: "POST",
    body: {
      name: `检索验收助理-${suffix}`,
      description: "自动验收后删除",
      category: "ANALYSIS",
      instructions: "涉及历史事实时必须先使用可用检索工具，并简短回答。",
      avatarColor: "#2F9D83",
      modelId: null,
      knowledgeBaseIds: [],
      toolGrants: { crossConversationSearch: true, privateMemoryRead: true },
    },
  });
  assistantId = created.assistant.id;
  assert.deepEqual(created.assistant.toolGrants, {
    crossConversationSearch: true,
    privateMemoryRead: true,
  });
  const threads = await request(`/api/ai/assistants/${assistantId}/threads`, { token });
  const threadId = threads.threads[0].id;

  const round = await request(`/api/ai/assistants/${assistantId}/threads/${threadId}/messages`, {
    token,
    method: "POST",
    body: {
      content: `请先调用 search_chat_messages 搜索 ${chatMarker}，再调用 search_memories 搜索 ${memoryMarker}，告诉我发布时间和回答偏好。`,
      fileIds: [],
    },
  });
  const reply = round.messages.find((item) => item.role === "ASSISTANT");
  assert.ok(reply, "助理应返回回答");
  assert.ok(
    reply.contextSources.some((source) => source.type === "MESSAGE" && source.id === message.id),
    "回答应保存实际使用的跨会话消息来源",
  );
  assert.ok(
    reply.contextSources.some((source) => source.type === "MEMORY" && source.id === memory.id),
    "回答应保存实际使用的私人记忆来源",
  );
  assert.match(reply.content, /16:30/, "回答应从聊天正文提取业务时间，而不是来源入库时间");
  assert.match(reply.content, /三条行动/, "回答应正确使用私人记忆中的表达偏好");

  await request(`/api/ai/assistants/${assistantId}`, {
    token,
    method: "PATCH",
    body: {
      toolGrants: { crossConversationSearch: false, privateMemoryRead: false },
    },
  });
  const disabledRound = await request(
    `/api/ai/assistants/${assistantId}/threads/${threadId}/messages`,
    {
      token,
      method: "POST",
      body: {
        content: `再次检索 ${chatMarker} 和 ${memoryMarker}。`,
        fileIds: [],
      },
    },
  );
  const disabledReply = disabledRound.messages.find((item) => item.role === "ASSISTANT");
  assert.deepEqual(disabledReply.contextSources, [], "关闭授权后不得保存聊天或记忆来源");

  console.log(
    "NearChat assistant context smoke passed: Mastra tools, scoped sources, source persistence and grant revocation are healthy",
  );
  if (keepFixtures) {
    console.log(
      `Acceptance fixture retained: assistantId=${assistantId} groupId=${groupId} memoryId=${memoryId}`,
    );
  }
} finally {
  if (!keepFixtures && token && assistantId) {
    await request(`/api/ai/assistants/${assistantId}`, { token, method: "DELETE" }).catch(
      () => undefined,
    );
  }
  if (!keepFixtures && token && groupId) {
    await request(`/api/conversations/${groupId}`, { token, method: "DELETE" }).catch(
      () => undefined,
    );
  }
  if (!keepFixtures && token && memoryId) {
    await request(`/api/memories/${memoryId}`, { token, method: "DELETE" }).catch(() => undefined);
  }
  if (!keepFixtures && memoryId) {
    await pool.query(`DELETE FROM memories WHERE id = $1`, [memoryId]).catch(() => undefined);
  }
  await pool.end();
}
