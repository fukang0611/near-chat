import assert from "node:assert/strict";
import WebSocket from "ws";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";

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

async function connectRealtime(token) {
  const websocketUrl = baseUrl.replace(/^http/, "ws");
  const socket = new WebSocket(`${websocketUrl}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function waitForRealtimeMessage(socket, predicate, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("等待提醒实时事件超时"));
    }, timeoutMs);
    const onMessage = (data) => {
      const event = JSON.parse(data.toString());
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
  });
}

const suffix = Date.now().toString(36);
let token;
let assistantId;
let socket;

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
      name: `提醒验收-${suffix}`,
      description: "自动验收后删除",
      category: "PLANNING",
      instructions: "整理日程与提醒。",
      avatarColor: "#6757E8",
      modelId: null,
      knowledgeBaseIds: [],
    },
  });
  assistantId = created.assistant.id;

  const directory = await request(`/api/ai/assistants/${assistantId}/threads`, { token });
  const threadId = directory.threads.find((thread) => thread.isDefault)?.id;
  assert.ok(threadId, "新助理应有默认对话");

  const task = await request(`/api/ai/assistants/${assistantId}/tasks`, {
    token,
    method: "POST",
    body: {
      threadId,
      title: `日程汇总-${suffix}`,
      prompt: "汇总今日事项。",
      scheduleType: "ONCE",
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      enabled: true,
      fileIds: [],
      browserAction: "NONE",
      browserUrl: null,
    },
  });

  socket = await connectRealtime(token);
  const reminderTitle = `检查提醒-${suffix}`;
  const reminderResult = await request(`/api/ai/assistants/${assistantId}/reminders`, {
    token,
    method: "POST",
    body: {
      threadId,
      title: reminderTitle,
      note: "验证实时通知与状态持久化",
      scheduledAt: new Date(Date.now() + 5_000).toISOString(),
    },
  });
  const reminder = reminderResult.reminder;

  const initialSchedule = await request(`/api/ai/assistants/${assistantId}/schedule`, { token });
  assert.equal(
    initialSchedule.tasks.some((item) => item.id === task.task.id),
    true,
  );
  assert.equal(initialSchedule.reminders[0]?.status, "PENDING");
  assert.equal(initialSchedule.reminders[0]?.threadId, threadId);

  const event = await waitForRealtimeMessage(
    socket,
    (candidate) =>
      candidate.type === "assistant.reminder.due" && candidate.payload?.reminderId === reminder.id,
  );
  assert.equal(event.payload.assistantId, assistantId);
  assert.equal(event.payload.threadId, threadId);
  assert.equal(event.payload.title, reminderTitle);

  const dueSchedule = await request(`/api/ai/assistants/${assistantId}/schedule`, { token });
  const dueReminder = dueSchedule.reminders.find((item) => item.id === reminder.id);
  assert.equal(dueReminder?.status, "DUE");
  assert.ok(dueReminder?.notifiedAt, "实时事件发送后应持久化通知时间");

  const snoozedAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const snoozed = await request(`/api/ai/assistants/${assistantId}/reminders/${reminder.id}`, {
    token,
    method: "PATCH",
    body: { scheduledAt: snoozedAt },
  });
  assert.equal(snoozed.reminder.status, "PENDING");
  assert.equal(snoozed.reminder.notifiedAt, null);

  const completed = await request(`/api/ai/assistants/${assistantId}/reminders/${reminder.id}`, {
    token,
    method: "PATCH",
    body: { completed: true },
  });
  assert.equal(completed.reminder.status, "COMPLETED");
  assert.ok(completed.reminder.completedAt);

  const reopened = await request(`/api/ai/assistants/${assistantId}/reminders/${reminder.id}`, {
    token,
    method: "PATCH",
    body: { completed: false },
  });
  assert.equal(reopened.reminder.status, "PENDING");

  const pausedTask = await request(`/api/ai/assistants/${assistantId}/tasks/${task.task.id}`, {
    token,
    method: "PATCH",
    body: { enabled: false },
  });
  assert.equal(pausedTask.task.enabled, false);

  await request(`/api/ai/assistants/${assistantId}/reminders/${reminder.id}`, {
    token,
    method: "DELETE",
  });
  const afterDelete = await request(`/api/ai/assistants/${assistantId}/schedule`, { token });
  assert.equal(
    afterDelete.reminders.some((item) => item.id === reminder.id),
    false,
  );

  await request(`/api/ai/assistants/${assistantId}`, { token, method: "DELETE" });
  assistantId = null;
  console.log(
    "NearChat assistant reminders smoke passed: unified schedule, due realtime event, snooze, complete, reopen and cleanup are healthy",
  );
} finally {
  socket?.close();
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
