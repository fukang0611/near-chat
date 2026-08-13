import pg from "pg";
import WebSocket from "ws";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const databaseUrl =
  process.env.SMOKE_DATABASE_URL ?? "postgres://near_chat:near_chat@localhost:15432/near_chat";

async function request(path, init = {}, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (expectedStatus !== undefined ? response.status !== expectedStatus : !response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status}: ${body?.message ?? "未知错误"}`,
    );
  }
  return body;
}

function auth(token, json = true) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function login(username, password) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

function waitForRealtimeMessage(socket, predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("等待实时事件超时"));
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

async function connectRealtime(token) {
  const websocketBaseUrl = baseUrl.replace(/^http/, "ws");
  const socket = new WebSocket(`${websocketBaseUrl}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

const pool = new pg.Pool({ connectionString: databaseUrl });
let groupId = null;
let aliceToken = null;
let recalledAttachmentId = null;
let bobSocket = null;

try {
  const [admin, alice, bob] = await Promise.all([
    login("admin", process.env.SMOKE_ADMIN_PASSWORD ?? "admin123"),
    login("alice", process.env.SMOKE_ALICE_PASSWORD ?? "alice123"),
    login("bob", process.env.SMOKE_BOB_PASSWORD ?? "bob123"),
  ]);
  aliceToken = alice.token;

  const group = await request("/api/conversations/groups", {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({
      name: `消息闭环验证-${Date.now().toString(36)}`,
      memberIds: [admin.user.id, bob.user.id],
    }),
  });
  groupId = group.conversationId;

  const sentMessages = [];
  const uniqueTextPrefix = `phase3-${Date.now().toString(36)}`;
  for (let index = 0; index < 7; index += 1) {
    const result = await request(`/api/conversations/${groupId}/messages`, {
      method: "POST",
      headers: auth(alice.token),
      body: JSON.stringify({
        clientMessageId: crypto.randomUUID(),
        text: `${uniqueTextPrefix}-${index}`,
      }),
    });
    sentMessages.push(result.message);
  }

  const idempotentClientMessageId = crypto.randomUUID();
  const firstIdempotent = await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({ clientMessageId: idempotentClientMessageId, text: "幂等重试验证" }),
  });
  const secondIdempotent = await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({ clientMessageId: idempotentClientMessageId, text: "幂等重试验证" }),
  });
  if (firstIdempotent.message.id !== secondIdempotent.message.id) {
    throw new Error("相同 clientMessageId 创建了重复消息");
  }
  sentMessages.push(firstIdempotent.message);

  // 将消息压到同一毫秒，验证复合游标在时间相同时仍不漏、不重。
  const sameCreatedAt = new Date().toISOString();
  await pool.query("UPDATE messages SET created_at = $1 WHERE id = ANY($2::uuid[])", [
    sameCreatedAt,
    sentMessages.map((message) => message.id),
  ]);

  const pagedMessageIds = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "3" });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`/api/conversations/${groupId}/messages?${query}`, {
      headers: auth(alice.token, false),
    });
    for (const message of page.messages) {
      if (pagedMessageIds.includes(message.id)) throw new Error("游标分页返回重复消息");
      pagedMessageIds.push(message.id);
    }
    cursor = page.hasMore ? page.nextCursor : null;
    if (page.hasMore && !cursor) throw new Error("分页仍有历史消息但缺少 nextCursor");
  } while (cursor);
  if (
    pagedMessageIds.length !== sentMessages.length ||
    sentMessages.some((message) => !pagedMessageIds.includes(message.id))
  ) {
    throw new Error("复合游标分页遗漏消息");
  }
  await request(
    `/api/conversations/${groupId}/messages?cursor=not-a-valid-cursor`,
    { headers: auth(alice.token, false) },
    400,
  );

  const source = sentMessages[0];
  const reply = await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({
      clientMessageId: crypto.randomUUID(),
      text: "引用回复验证",
      replyToMessageId: source.id,
    }),
  });
  if (reply.message.replyTo?.id !== source.id) throw new Error("引用关系未写入响应");

  await request(
    `/api/conversations/${groupId}/messages/${source.id}/recall`,
    { method: "POST", headers: auth(bob.token, false) },
    403,
  );

  bobSocket = await connectRealtime(bob.token);
  const direct = await request(`/api/conversations/direct/${bob.user.id}`, {
    method: "POST",
    headers: auth(alice.token, false),
  });
  const nudgeReceived = waitForRealtimeMessage(
    bobSocket,
    (event) =>
      event.type === "nudge.received" &&
      event.payload?.conversationId === direct.conversationId &&
      event.payload?.senderId === alice.user.id,
  );
  await request(`/api/conversations/${direct.conversationId}/nudge`, {
    method: "POST",
    headers: auth(alice.token, false),
  });
  await nudgeReceived;
  await request(
    `/api/conversations/${direct.conversationId}/nudge`,
    { method: "POST", headers: auth(alice.token, false) },
    429,
  );

  const realtimeUpdate = waitForRealtimeMessage(
    bobSocket,
    (event) => event.type === "message.updated" && event.payload?.message?.id === source.id,
  );
  const recalled = await request(`/api/conversations/${groupId}/messages/${source.id}/recall`, {
    method: "POST",
    headers: auth(alice.token, false),
  });
  if (!recalled.message.recalledAt || recalled.message.textContent !== null) {
    throw new Error("撤回后仍暴露原消息内容");
  }
  await realtimeUpdate;
  const idempotentRecall = await request(
    `/api/conversations/${groupId}/messages/${source.id}/recall`,
    { method: "POST", headers: auth(alice.token, false) },
  );
  if (idempotentRecall.message.recalledAt !== recalled.message.recalledAt) {
    throw new Error("重复撤回没有返回稳定结果");
  }
  const replyRetry = await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({
      clientMessageId: reply.message.clientMessageId,
      text: "引用回复验证",
      replyToMessageId: source.id,
    }),
  });
  if (replyRetry.message.id !== reply.message.id) {
    throw new Error("引用源撤回后的幂等重试未返回原消息");
  }

  const aroundReply = await request(
    `/api/conversations/${groupId}/messages?around=${reply.message.id}&limit=20`,
    { headers: auth(alice.token, false) },
  );
  const refreshedReply = aroundReply.messages.find((message) => message.id === reply.message.id);
  if (!refreshedReply?.replyTo?.recalled) throw new Error("引用摘要未同步原消息撤回状态");
  await request(
    `/api/conversations/${groupId}/messages`,
    {
      method: "POST",
      headers: auth(alice.token),
      body: JSON.stringify({
        clientMessageId: crypto.randomUUID(),
        text: "不应发送成功",
        replyToMessageId: source.id,
      }),
    },
    400,
  );

  const search = await request(
    `/api/messages/search?q=${encodeURIComponent(uniqueTextPrefix)}&conversationId=${groupId}`,
    { headers: auth(alice.token, false) },
  );
  if (search.messages.some((message) => message.id === source.id)) {
    throw new Error("搜索结果仍包含已撤回消息");
  }

  const expired = sentMessages[1];
  await pool.query("UPDATE messages SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [
    expired.id,
  ]);
  await request(
    `/api/conversations/${groupId}/messages/${expired.id}/recall`,
    { method: "POST", headers: auth(alice.token, false) },
    409,
  );

  const form = new FormData();
  form.append("file", new Blob(["recall attachment"], { type: "text/plain" }), "recall.txt");
  const uploaded = await request("/api/files", {
    method: "POST",
    headers: auth(alice.token, false),
    body: form,
  });
  recalledAttachmentId = uploaded.attachment.id;
  const attachmentClientMessageId = crypto.randomUUID();
  const attachmentInput = JSON.stringify({
    clientMessageId: attachmentClientMessageId,
    text: "附件撤回验证",
    attachmentIds: [recalledAttachmentId],
  });
  const [attachmentMessage, attachmentRetry] = await Promise.all([
    request(`/api/conversations/${groupId}/messages`, {
      method: "POST",
      headers: auth(alice.token),
      body: attachmentInput,
    }),
    request(`/api/conversations/${groupId}/messages`, {
      method: "POST",
      headers: auth(alice.token),
      body: attachmentInput,
    }),
  ]);
  if (attachmentRetry.message.id !== attachmentMessage.message.id) {
    throw new Error("已绑定附件的幂等重试未返回原消息");
  }
  await request(`/api/conversations/${groupId}/messages/${attachmentMessage.message.id}/recall`, {
    method: "POST",
    headers: auth(alice.token, false),
  });
  const attachmentState = await pool.query(
    "SELECT message_id, state FROM attachments WHERE id = $1",
    [recalledAttachmentId],
  );
  if (
    attachmentState.rows[0]?.message_id !== null ||
    attachmentState.rows[0]?.state !== "CLEANUP_FAILED"
  ) {
    throw new Error("撤回附件没有进入隔离回收状态");
  }
  await request(`/api/files/${recalledAttachmentId}`, {
    method: "DELETE",
    headers: auth(alice.token, false),
  });
  recalledAttachmentId = null;

  console.log(
    "NearChat phase-3 smoke passed: cursor, reply, recall, nudge, realtime and idempotent retry are healthy",
  );
} finally {
  bobSocket?.close();
  if (recalledAttachmentId && aliceToken) {
    await request(`/api/files/${recalledAttachmentId}`, {
      method: "DELETE",
      headers: auth(aliceToken, false),
    }).catch(() => undefined);
  }
  if (groupId && aliceToken) {
    await request(`/api/conversations/${groupId}`, {
      method: "DELETE",
      headers: auth(aliceToken, false),
    }).catch(() => undefined);
    await pool.query("DELETE FROM audit_logs WHERE target_id = $1", [groupId]);
  }
  await pool.end();
}
