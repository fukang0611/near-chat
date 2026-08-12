const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const username = process.env.SMOKE_USERNAME ?? "alice";
const password = process.env.SMOKE_PASSWORD ?? "alice123";

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status}: ${body?.message ?? "未知错误"}`,
    );
  }
  return body;
}

// 冒烟检查只读取现有数据，不创建用户、消息或附件，适合在开发环境重复执行。
const health = await json("/api/health");
await json("/api/health/live");
await json("/api/health/ready");
const login = await json("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
const headers = { Authorization: `Bearer ${login.token}` };
const users = await json("/api/users", { headers });
const conversations = await json("/api/conversations", { headers });
const search = await json("/api/messages/search?q=__near_chat_smoke_noop__&limit=1", { headers });

if (!Array.isArray(search.messages)) throw new Error("消息搜索响应格式错误");
if (
  conversations.conversations.some(
    (conversation) =>
      !["DIRECT", "GROUP"].includes(conversation.type) || !Array.isArray(conversation.members),
  )
) {
  throw new Error("会话响应格式错误");
}

if (conversations.conversations[0]) {
  const conversationId = conversations.conversations[0].id;
  await json(`/api/conversations/${conversationId}/messages?limit=1`, { headers });
}

console.log(
  `NearChat smoke passed: health=${health.status}, user=${login.user.username}, ` +
    `contacts=${users.users.length}, conversations=${conversations.conversations.length}`,
);
