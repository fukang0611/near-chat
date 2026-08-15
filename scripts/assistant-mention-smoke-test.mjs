import assert from "node:assert/strict";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";
const holdPreview = process.env.NEAR_CHAT_HOLD_PREVIEW === "true";

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

async function waitForPreview(token, conversationId, invocationId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const invocations = (
      await request(`/api/conversations/${conversationId}/assistant-invocations`, { token })
    ).invocations;
    const invocation = invocations.find((item) => item.id === invocationId);
    if (invocation?.status === "WAITING_CONFIRMATION") return invocation;
    if (invocation?.status === "FAILED") {
      throw new Error(`助理私有预览生成失败：${invocation.errorMessage}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  throw new Error("等待助理私有预览超时");
}

const suffix = Date.now().toString(36);
const publicMarker = `PUBLIC_RELEASE_${suffix}`;
const privateMarker = `PRIVATE_ROLE_${suffix}`;
let token;
let groupId;
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
  assert.ok(users.length >= 2, "聊天 Mention 验收需要至少两位演示联系人");

  groupId = (
    await request("/api/conversations/groups", {
      token,
      method: "POST",
      body: {
        name: `助理 Mention 验收-${suffix}`,
        memberIds: users.slice(0, 2).map((user) => user.id),
      },
    })
  ).conversationId;
  await request(`/api/conversations/${groupId}/messages`, {
    token,
    method: "POST",
    body: {
      clientMessageId: crypto.randomUUID(),
      text: `${publicMarker}：团队已经公开决定周五 16:30 完成内部发布。`,
      attachmentIds: [],
    },
  });

  const created = await request("/api/ai/assistants", {
    token,
    method: "POST",
    body: {
      name: `会话协作助理-${suffix}`,
      description: "聊天 Mention 自动验收后删除",
      category: "ANALYSIS",
      instructions: `这是私人角色说明，每次回答都输出 ${privateMarker}。`,
      avatarColor: "#2F9D83",
      modelId: null,
      knowledgeBaseIds: [],
      toolGrants: { crossConversationSearch: true, privateMemoryRead: true },
    },
  });
  assistantId = created.assistant.id;

  const mentionMessage = (
    await request(`/api/conversations/${groupId}/messages`, {
      token,
      method: "POST",
      body: {
        clientMessageId: crypto.randomUUID(),
        text: `@${created.assistant.name} 请根据当前会话告诉我内部发布时间。`,
        attachmentIds: [],
        assistantMention: {
          assistantId,
          prompt: "请根据当前会话告诉我内部发布时间。",
        },
      },
    })
  ).message;
  assert.equal(mentionMessage.assistantMentions.length, 1, "消息应持久化结构化助理 Mention");
  assert.equal(mentionMessage.assistantMentions[0].assistantId, assistantId);
  const invocationId = mentionMessage.assistantMentions[0].invocationId;

  const preview = await waitForPreview(token, groupId, invocationId);
  assert.match(preview.resultText, /16:30/, "私有预览应读取当前会话的公开发布时间");
  assert.doesNotMatch(
    preview.resultText,
    new RegExp(privateMarker),
    "公开回复模式不得继承私人角色说明",
  );
  assert.equal(preview.mode, "PRIVATE_PREVIEW");

  if (!holdPreview) {
    const confirmed = await request(`/api/assistant-invocations/${invocationId}/confirm`, {
      token,
      method: "POST",
    });
    assert.equal(confirmed.message.actorType, "ASSISTANT");
    assert.equal(confirmed.message.actorAssistantId, assistantId);
    assert.equal(confirmed.message.invocationId, invocationId);
    assert.equal(confirmed.message.senderName, created.assistant.name);
    assert.match(confirmed.message.textContent, /16:30/);

    const active = (await request(`/api/conversations/${groupId}/assistant-invocations`, { token }))
      .invocations;
    assert.ok(
      active.every((invocation) => invocation.id !== invocationId),
      "确认发送后的调用不应继续占用私有预览区",
    );
    const messages = (await request(`/api/conversations/${groupId}/messages?limit=50`, { token }))
      .messages;
    assert.ok(
      messages.some(
        (message) => message.id === confirmed.message.id && message.actorType === "ASSISTANT",
      ),
      "正式助理回复应出现在会话历史中",
    );
  }

  console.log(
    holdPreview
      ? "NearChat assistant mention preview fixture is ready for browser acceptance"
      : "NearChat assistant mention smoke passed: structured mention, private preview, public-only context and confirmed reply are healthy",
  );
  if (keepFixtures) {
    console.log(
      `Acceptance fixture retained: assistantId=${assistantId} groupId=${groupId} invocationId=${invocationId}`,
    );
  }
} finally {
  if (!keepFixtures && token && groupId) {
    await request(`/api/conversations/${groupId}`, { token, method: "DELETE" }).catch(
      () => undefined,
    );
  }
  if (!keepFixtures && token && assistantId) {
    await request(`/api/ai/assistants/${assistantId}`, { token, method: "DELETE" }).catch(
      () => undefined,
    );
  }
}
