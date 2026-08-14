import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const credentials = {
  admin: process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123",
  alice: process.env.NEAR_CHAT_ALICE_PASSWORD ?? "alice123",
  bob: process.env.NEAR_CHAT_BOB_PASSWORD ?? "bob123",
};

async function request(path, { token, method = "GET", body, raw = false } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined && !(body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${path} returned ${response.status}: ${message.slice(0, 240)}`);
  }
  if (raw || response.status === 204) return response;
  return response.json();
}

async function expectStatus(path, status, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.body),
  });
  assert.equal(response.status, status, `${options.method} ${path} should return ${status}`);
}

async function login(username, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  return result.token;
}

const suffix = Date.now().toString(36);
let adminToken;
let aliceToken;
let bobToken;
let knowledgeBaseId;
let assistantId;
let attachmentId;

try {
  [adminToken, aliceToken, bobToken] = await Promise.all([
    login("admin", credentials.admin),
    login("alice", credentials.alice),
    login("bob", credentials.bob),
  ]);

  const created = await request("/api/knowledge-bases", {
    token: adminToken,
    method: "POST",
    body: { name: `共享验收-${suffix}`, description: "自动验收后删除" },
  });
  knowledgeBaseId = created.knowledgeBase.id;
  assert.equal(created.knowledgeBase.accessRole, "OWNER");

  const directory = await request(`/api/knowledge-bases/${knowledgeBaseId}/members`, {
    token: adminToken,
  });
  const alice = directory.candidates.find((candidate) => candidate.username === "alice");
  const bob = directory.candidates.find((candidate) => candidate.username === "bob");
  assert.ok(alice && bob, "demo members should be available for sharing");

  await request(`/api/knowledge-bases/${knowledgeBaseId}/members`, {
    token: adminToken,
    method: "PUT",
    body: {
      members: [
        { userId: alice.id, role: "EDITOR" },
        { userId: bob.id, role: "VIEWER" },
      ],
    },
  });

  const [aliceBases, bobBases] = await Promise.all([
    request("/api/knowledge-bases", { token: aliceToken }),
    request("/api/knowledge-bases", { token: bobToken }),
  ]);
  assert.equal(
    aliceBases.knowledgeBases.find((base) => base.id === knowledgeBaseId)?.accessRole,
    "EDITOR",
  );
  assert.equal(
    bobBases.knowledgeBases.find((base) => base.id === knowledgeBaseId)?.accessRole,
    "VIEWER",
  );

  const form = new FormData();
  form.append(
    "file",
    new Blob(["NearChat shared knowledge acceptance text."], { type: "text/plain" }),
    `shared-${suffix}.txt`,
  );
  const uploaded = await request("/api/files", {
    token: aliceToken,
    method: "POST",
    body: form,
  });
  attachmentId = uploaded.attachment.id;
  await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
    token: aliceToken,
    method: "POST",
    body: { attachmentId },
  });

  const bobDocuments = await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
    token: bobToken,
  });
  assert.equal(bobDocuments.documents[0]?.attachment.id, attachmentId);
  await request(`/api/files/${attachmentId}/content`, { token: bobToken, raw: true });
  await expectStatus(`/api/knowledge-bases/${knowledgeBaseId}/documents`, 403, {
    token: bobToken,
    method: "POST",
    body: { attachmentId },
  });

  const assistant = await request("/api/ai/assistants", {
    token: aliceToken,
    method: "POST",
    body: {
      name: `共享资料助理-${suffix}`,
      description: "自动验收后删除",
      category: "ANALYSIS",
      instructions: "只使用已授权的知识库",
      avatarColor: "#6757E8",
      modelId: null,
      knowledgeBaseIds: [knowledgeBaseId],
    },
  });
  assistantId = assistant.assistant.id;
  assert.deepEqual(assistant.assistant.knowledgeBaseIds, [knowledgeBaseId]);

  await request(`/api/knowledge-bases/${knowledgeBaseId}/members`, {
    token: adminToken,
    method: "PUT",
    body: { members: [{ userId: bob.id, role: "VIEWER" }] },
  });
  const aliceAfterRevoke = await request("/api/knowledge-bases", { token: aliceToken });
  assert.equal(
    aliceAfterRevoke.knowledgeBases.some((base) => base.id === knowledgeBaseId),
    false,
  );
  const assistantsAfterRevoke = await request("/api/ai/assistants", { token: aliceToken });
  assert.deepEqual(
    assistantsAfterRevoke.assistants.find((item) => item.id === assistantId)?.knowledgeBaseIds,
    [],
  );

  console.log(
    "NearChat knowledge sharing smoke passed: owner, editor, viewer, file access and revoke cleanup are healthy",
  );
} finally {
  if (assistantId && aliceToken) {
    await request(`/api/ai/assistants/${assistantId}`, {
      token: aliceToken,
      method: "DELETE",
    }).catch(() => undefined);
  }
  if (knowledgeBaseId && adminToken) {
    await request(`/api/knowledge-bases/${knowledgeBaseId}`, {
      token: adminToken,
      method: "DELETE",
    }).catch(() => undefined);
  }
  if (attachmentId && aliceToken) {
    await request(`/api/files/${attachmentId}`, {
      token: aliceToken,
      method: "DELETE",
    }).catch(() => undefined);
  }
}
