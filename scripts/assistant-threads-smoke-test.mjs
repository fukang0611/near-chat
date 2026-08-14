import assert from "node:assert/strict";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";

async function request(path, { token, method = "GET", body, expectedStatus } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (expectedStatus !== undefined) {
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${path} should return ${expectedStatus}`,
    );
    return result;
  }
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${result?.message ?? "未知错误"}`,
    );
  }
  return result;
}

const suffix = Date.now().toString(36);
const defaultMarker = `DEFAULT_THREAD_${suffix}`;
const projectMarker = `PROJECT_THREAD_${suffix}`;
let token;
let assistantId;

try {
  token = (
    await request("/api/auth/login", {
      method: "POST",
      body: { username: "admin", password },
    })
  ).token;

  const created = await request("/api/ai/assistants", {
    token,
    method: "POST",
    body: {
      name: `多对话验收-${suffix}`,
      description: "自动验收后删除",
      category: "GENERAL",
      instructions: "简短确认用户消息，不要改写其中的大写验收标记。",
      avatarColor: "#6757E8",
      modelId: null,
      knowledgeBaseIds: [],
    },
  });
  assistantId = created.assistant.id;

  const initialDirectory = await request(
    `/api/ai/assistants/${assistantId}/threads?includeArchived=true`,
    { token },
  );
  assert.equal(initialDirectory.threads.length, 1);
  const defaultThread = initialDirectory.threads[0];
  assert.equal(defaultThread.title, "默认对话");
  assert.equal(defaultThread.isDefault, true);

  const defaultRound = await request(
    `/api/ai/assistants/${assistantId}/threads/${defaultThread.id}/messages`,
    {
      token,
      method: "POST",
      body: { content: `请确认 ${defaultMarker}`, fileIds: [] },
    },
  );
  assert.ok(defaultRound.messages.every((message) => message.threadId === defaultThread.id));

  const projectCreated = await request(`/api/ai/assistants/${assistantId}/threads`, {
    token,
    method: "POST",
    body: { title: "项目讨论" },
  });
  const projectThread = projectCreated.thread;
  assert.equal(projectThread.isDefault, false);

  const emptyProject = await request(
    `/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`,
    { token },
  );
  assert.deepEqual(emptyProject.messages, []);

  const projectRound = await request(
    `/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`,
    {
      token,
      method: "POST",
      body: { content: `请确认 ${projectMarker}`, fileIds: [] },
    },
  );
  const projectUserMessage = projectRound.messages.find((message) => message.role === "USER");
  assert.ok(projectUserMessage);
  assert.ok(projectRound.messages.every((message) => message.threadId === projectThread.id));

  const [defaultMessages, projectMessages, location] = await Promise.all([
    request(`/api/ai/assistants/${assistantId}/threads/${defaultThread.id}/messages`, { token }),
    request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`, { token }),
    request(`/api/ai/assistants/${assistantId}/messages/${projectUserMessage.id}/location`, {
      token,
    }),
  ]);
  assert.ok(defaultMessages.messages.some((message) => message.content.includes(defaultMarker)));
  assert.ok(
    defaultMessages.messages.every((message) => !message.content.includes(projectMarker)),
    "默认对话不应混入项目线程消息",
  );
  assert.ok(projectMessages.messages.some((message) => message.content.includes(projectMarker)));
  assert.ok(
    projectMessages.messages.every((message) => !message.content.includes(defaultMarker)),
    "项目对话不应混入默认线程消息",
  );
  assert.equal(location.threadId, projectThread.id);

  const renamed = await request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}`, {
    token,
    method: "PATCH",
    body: { title: "项目 Alpha" },
  });
  assert.equal(renamed.thread.title, "项目 Alpha");

  const task = await request(`/api/ai/assistants/${assistantId}/tasks`, {
    token,
    method: "POST",
    body: {
      threadId: projectThread.id,
      title: `线程任务-${suffix}`,
      prompt: "输出线程任务验收通过。",
      scheduleType: "ONCE",
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      enabled: true,
      fileIds: [],
      browserAction: "NONE",
      browserUrl: null,
    },
  });
  assert.equal(task.task.threadId, projectThread.id);

  await request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}`, {
    token,
    method: "PATCH",
    body: { archived: true },
  });
  const [activeDirectory, archivedDirectory, archivedMessages, archivedTasks] = await Promise.all([
    request(`/api/ai/assistants/${assistantId}/threads`, { token }),
    request(`/api/ai/assistants/${assistantId}/threads?includeArchived=true`, { token }),
    request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`, { token }),
    request(`/api/ai/assistants/${assistantId}/tasks?threadId=${projectThread.id}`, { token }),
  ]);
  assert.equal(
    activeDirectory.threads.some((thread) => thread.id === projectThread.id),
    false,
  );
  assert.equal(
    archivedDirectory.threads.find((thread) => thread.id === projectThread.id)?.archived,
    true,
  );
  assert.ok(archivedMessages.messages.some((message) => message.id === projectUserMessage.id));
  assert.equal(archivedTasks.tasks[0]?.enabled, false, "归档时应暂停所属自动任务");
  await request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`, {
    token,
    method: "POST",
    body: { content: "归档后不可发送", fileIds: [] },
    expectedStatus: 409,
  });
  await request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}/messages`, {
    token,
    method: "DELETE",
    expectedStatus: 409,
  });

  await request(`/api/ai/assistants/${assistantId}/threads/${projectThread.id}`, {
    token,
    method: "PATCH",
    body: { archived: false },
  });
  const legacyMessages = await request(`/api/ai/assistants/${assistantId}/messages`, { token });
  assert.ok(
    legacyMessages.messages.some((message) => message.content.includes(defaultMarker)),
    "旧客户端入口应继续落在默认对话",
  );

  await request(`/api/ai/assistants/${assistantId}`, { token, method: "DELETE" });
  const afterDelete = await request(
    `/api/ai/assistants/${assistantId}/threads?includeArchived=true`,
    { token },
  );
  assert.deepEqual(afterDelete.threads, [], "删除助理后线程应被级联清理");
  assistantId = null;

  console.log(
    "NearChat assistant threads smoke passed: migration default, isolated timelines, location, archive, task binding and cascade are healthy",
  );
} finally {
  if (!keepFixtures && assistantId && token) {
    await request(`/api/ai/assistants/${assistantId}`, {
      token,
      method: "DELETE",
    }).catch(() => undefined);
  }
  if (keepFixtures && assistantId) {
    console.log(`Acceptance fixture retained: assistantId=${assistantId}`);
  }
}
