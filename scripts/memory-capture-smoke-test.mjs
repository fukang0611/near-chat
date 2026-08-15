import assert from "node:assert/strict";
import pg from "pg";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
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

async function waitFor(predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("等待会话记忆整理结果超时");
}

const suffix = Date.now().toString(36);
const groupName = `记忆验收-${suffix}`;
let token;
let ownerId;
let groupId;
let memoryId;
let originalSettings;

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password },
  });
  token = login.token;
  ownerId = login.user.id;
  originalSettings = (await request("/api/memory-settings", { token })).settings;

  const users = (await request("/api/users", { token })).users.filter(
    (user) => user.id !== ownerId,
  );
  assert.ok(users.length >= 2, "记忆验收需要至少两位演示联系人");
  groupId = (
    await request("/api/conversations/groups", {
      token,
      method: "POST",
      body: { name: groupName, memberIds: users.slice(0, 2).map((user) => user.id) },
    })
  ).conversationId;

  const enabled = await request("/api/memory-settings", {
    token,
    method: "PATCH",
    body: { semanticCaptureEnabled: true },
  });
  assert.equal(enabled.settings.semanticCaptureEnabled, true);

  const facts = [
    `项目代号是 ${groupName}，用于验证会话长期记忆。`,
    "团队明确决定每周五下午发布内部版本。",
    "发布前必须先完成离线安装包验收。",
    "交付清单统一使用 PDF 格式。",
    "如果验收未通过，本周发布自动顺延。",
  ];
  for (let index = 0; index < 20; index += 1) {
    await request(`/api/conversations/${groupId}/messages`, {
      token,
      method: "POST",
      body: {
        clientMessageId: crypto.randomUUID(),
        text: `${facts[index % facts.length]}（验收片段 ${index + 1}/20）`,
        attachmentIds: [],
      },
    });
  }

  const candidates = await waitFor(async () => {
    const page = await request("/api/memory-candidates", { token });
    const matching = page.candidates.filter(
      (candidate) => candidate.source.conversationId === groupId,
    );
    return matching.length > 0 ? matching : null;
  });
  const candidate = candidates[0];
  assert.equal(candidate.status, "PENDING");
  assert.ok(candidate.source.id, "智能候选必须保留可定位的原消息");

  const duplicate = await request(`/api/messages/${candidate.source.id}/memory-candidate`, {
    token,
    method: "POST",
  });
  assert.equal(duplicate.created, false, "同一来源再次加入候选时应合并");
  assert.equal(duplicate.candidate.id, candidate.id);

  const around = await request(
    `/api/conversations/${groupId}/messages?around=${candidate.source.id}&limit=50`,
    { token },
  );
  assert.equal(
    around.messages.some((message) => message.id === candidate.source.id),
    true,
    "候选来源应能通过 around 接口精确定位",
  );

  const accepted = await request(`/api/memory-candidates/${candidate.id}/accept`, {
    token,
    method: "POST",
    body: { tier: "SHORT_TERM" },
  });
  memoryId = accepted.memory.id;
  assert.equal(accepted.memory.tier, "SHORT_TERM");
  assert.equal(accepted.memory.sources[0]?.conversationId, groupId);

  const shortTerm = await request("/api/memories?tier=SHORT_TERM&limit=200&offset=0", { token });
  assert.equal(
    shortTerm.memories.some((memory) => memory.id === memoryId),
    true,
  );
  console.log(
    `NearChat memory capture smoke passed: 20-message batching, AI candidate, dedupe, source jump and short-term acceptance are healthy`,
  );
} finally {
  if (token) {
    const pending = await request("/api/memory-candidates", { token }).catch(() => ({
      candidates: [],
    }));
    for (const candidate of pending.candidates.filter(
      (item) => item.source.conversationId === groupId,
    )) {
      await request(`/api/memory-candidates/${candidate.id}`, {
        token,
        method: "DELETE",
      }).catch(() => undefined);
    }
    if (memoryId) {
      await request(`/api/memories/${memoryId}`, { token, method: "DELETE" }).catch(
        () => undefined,
      );
    }
    if (groupId) {
      await request(`/api/conversations/${groupId}`, { token, method: "DELETE" }).catch(
        () => undefined,
      );
    }
    if (originalSettings) {
      await request("/api/memory-settings", {
        token,
        method: "PATCH",
        body: {
          explicitCaptureEnabled: originalSettings.explicitCaptureEnabled,
          semanticCaptureEnabled: originalSettings.semanticCaptureEnabled,
        },
      }).catch(() => undefined);
    }
  }
  // 只硬删除本脚本带唯一名称的验收派生行，避免软删除记录污染开发数据库。
  await pool
    .query(`DELETE FROM memory_candidates WHERE source_label LIKE $1`, [`${groupName}%`])
    .catch(() => undefined);
  if (memoryId) {
    await pool.query(`DELETE FROM memories WHERE id = $1`, [memoryId]).catch(() => undefined);
  }
  if (ownerId && originalSettings?.updatedAt === null) {
    await pool
      .query(`DELETE FROM memory_settings WHERE owner_id = $1`, [ownerId])
      .catch(() => undefined);
  }
  await pool.end();
}
