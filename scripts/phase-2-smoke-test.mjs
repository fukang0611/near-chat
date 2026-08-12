import pg from "pg";

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

const suffix = Date.now().toString(36);
const username = `phase2_${suffix}`;
const initialPassword = `Init_${suffix}`;
const nextPassword = `Next_${suffix}`;
let temporaryUserId = null;
let groupId = null;
let createdGroupId = null;
let groupOwnerToken = null;
let uploadedFileId = null;
let groupAttachmentId = null;
let aliceToken = null;

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const [admin, alice, bob] = await Promise.all([
    login("admin", process.env.SMOKE_ADMIN_PASSWORD ?? "admin123"),
    login("alice", process.env.SMOKE_ALICE_PASSWORD ?? "alice123"),
    login("bob", process.env.SMOKE_BOB_PASSWORD ?? "bob123"),
  ]);
  aliceToken = alice.token;
  const created = await request("/api/admin/users", {
    method: "POST",
    headers: auth(admin.token),
    body: JSON.stringify({
      username,
      displayName: "阶段二临时用户",
      password: initialPassword,
      role: "USER",
    }),
  });
  temporaryUserId = created.user.id;

  let temporary = await login(username, initialPassword);
  const profile = await request("/api/auth/profile", {
    method: "PATCH",
    headers: auth(temporary.token),
    body: JSON.stringify({ displayName: "阶段二验证用户", avatarColor: "#4A86D8" }),
  });
  if (profile.user.displayName !== "阶段二验证用户") throw new Error("个人资料更新未生效");

  const quotaBefore = await request("/api/files/quota", { headers: auth(temporary.token, false) });
  const form = new FormData();
  form.append("file", new Blob(["near-chat phase two"], { type: "text/plain" }), "phase-2.txt");
  const uploaded = await request("/api/files", {
    method: "POST",
    headers: auth(temporary.token, false),
    body: form,
  });
  uploadedFileId = uploaded.attachment.id;
  const quotaAfter = await request("/api/files/quota", { headers: auth(temporary.token, false) });
  if (quotaAfter.usedBytes <= quotaBefore.usedBytes) throw new Error("文件配额未计入新附件");
  await request(`/api/files/${uploadedFileId}`, {
    method: "DELETE",
    headers: auth(temporary.token, false),
  });
  uploadedFileId = null;

  const group = await request("/api/conversations/groups", {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({
      name: "阶段二验证群",
      memberIds: [admin.user.id, bob.user.id],
    }),
  });
  groupId = group.conversationId;
  createdGroupId = groupId;
  groupOwnerToken = alice.token;
  await request(`/api/conversations/${groupId}/group`, {
    method: "PATCH",
    headers: auth(alice.token),
    body: JSON.stringify({ name: "阶段二群管理验证", avatarColor: "#2F9E83" }),
  });
  await request(`/api/conversations/${groupId}/members`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({ memberIds: [temporaryUserId] }),
  });
  const temporaryConversations = await request("/api/conversations", {
    headers: auth(temporary.token, false),
  });
  const temporaryGroup = temporaryConversations.conversations.find((item) => item.id === groupId);
  if (!temporaryGroup) {
    throw new Error("新增群成员未看到群聊");
  }
  if (temporaryGroup.ownerId !== alice.user.id || temporaryGroup.memberCount !== 4) {
    throw new Error("群主或群成员信息响应错误");
  }
  await request(`/api/conversations/${groupId}/members/${temporaryUserId}`, {
    method: "DELETE",
    headers: auth(alice.token, false),
  });
  await request(`/api/conversations/${groupId}/transfer-owner`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({ userId: bob.user.id }),
  });
  groupOwnerToken = bob.token;

  const groupFileForm = new FormData();
  groupFileForm.append(
    "file",
    new Blob(["group cleanup smoke"], { type: "text/plain" }),
    "group-cleanup-smoke.txt",
  );
  const groupFile = await request("/api/files", {
    method: "POST",
    headers: auth(alice.token, false),
    body: groupFileForm,
  });
  groupAttachmentId = groupFile.attachment.id;
  await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    headers: auth(alice.token),
    body: JSON.stringify({
      clientMessageId: crypto.randomUUID(),
      text: "群聊附件清理验证",
      attachmentIds: [groupAttachmentId],
    }),
  });
  await request(
    `/api/conversations/${groupId}/group`,
    {
      method: "PATCH",
      headers: auth(alice.token),
      body: JSON.stringify({ name: "不应成功" }),
    },
    403,
  );
  await request(`/api/conversations/${groupId}`, {
    method: "DELETE",
    headers: auth(bob.token, false),
  });
  groupId = null;
  const stagedAttachment = await pool.query(
    "SELECT message_id, state FROM attachments WHERE id = $1",
    [groupAttachmentId],
  );
  if (
    stagedAttachment.rows[0]?.message_id !== null ||
    stagedAttachment.rows[0]?.state !== "CLEANUP_FAILED"
  ) {
    throw new Error("群聊解散后附件未进入可重试回收状态");
  }
  await request(`/api/files/${groupAttachmentId}`, {
    method: "DELETE",
    headers: auth(alice.token, false),
  });
  groupAttachmentId = null;

  await request(`/api/admin/users/${temporaryUserId}/force-logout`, {
    method: "POST",
    headers: auth(admin.token, false),
  });
  await request("/api/auth/me", { headers: auth(temporary.token, false) }, 401);
  temporary = await login(username, initialPassword);
  await request("/api/auth/change-password", {
    method: "POST",
    headers: auth(temporary.token),
    body: JSON.stringify({ currentPassword: initialPassword, newPassword: nextPassword }),
  });
  await request("/api/auth/me", { headers: auth(temporary.token, false) }, 401);
  await login(username, nextPassword);

  const audit = await request("/api/admin/audit-logs?limit=100", {
    headers: auth(admin.token, false),
  });
  const actions = new Set(audit.logs.map((item) => item.action));
  for (const action of [
    "ADMIN_USER_CREATE",
    "PROFILE_UPDATE",
    "GROUP_MEMBERS_ADD",
    "GROUP_MEMBER_REMOVE",
    "GROUP_OWNER_TRANSFER",
    "GROUP_DISBAND",
    "ADMIN_FORCE_LOGOUT",
    "PASSWORD_CHANGE",
  ]) {
    if (!actions.has(action)) throw new Error(`操作日志缺少 ${action}`);
  }

  console.log(
    "NearChat phase-2 smoke passed: group, account, audit and file governance are healthy",
  );
} finally {
  // 无论验证在哪一步中断，都尽量回收临时群聊、附件、账号和对应审计记录。
  if (groupId && groupOwnerToken) {
    await request(`/api/conversations/${groupId}`, {
      method: "DELETE",
      headers: auth(groupOwnerToken, false),
    }).catch(() => undefined);
  }
  if (uploadedFileId && temporaryUserId) {
    const current = await login(username, nextPassword).catch(() =>
      login(username, initialPassword),
    );
    await request(`/api/files/${uploadedFileId}`, {
      method: "DELETE",
      headers: auth(current.token, false),
    }).catch(() => undefined);
  }
  if (groupAttachmentId && aliceToken) {
    await request(`/api/files/${groupAttachmentId}`, {
      method: "DELETE",
      headers: auth(aliceToken, false),
    }).catch(() => undefined);
  }
  if (temporaryUserId) {
    await pool.query(
      `DELETE FROM audit_logs
        WHERE actor_id = $1::uuid
           OR target_id = $1::text
           OR target_id = $2::text`,
      [temporaryUserId, createdGroupId],
    );
    await pool.query("DELETE FROM users WHERE id = $1", [temporaryUserId]);
  }
  await pool.end();
}
