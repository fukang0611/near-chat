import assert from "node:assert/strict";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";

async function request(path, { token, method = "GET", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${result?.message ?? "未知错误"}`,
    );
  }
  return result;
}

async function waitForTask(token, assistantId, taskId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const result = await request(`/api/ai/assistants/${assistantId}/tasks`, { token });
    const task = result.tasks.find((candidate) => candidate.id === taskId);
    const run = task?.recentRuns[0];
    if (run?.status === "SUCCEEDED") return { task, run };
    if (run?.status === "FAILED") throw new Error(run.errorMessage ?? "自动任务执行失败");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("等待自动任务完成超时");
}

const suffix = Date.now().toString(36);
const fileMarker = `TASK_FILE_MARKER_${suffix}`;
let token;
let assistantId;
const cleanupAttachmentIds = [];

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
      name: `工具任务验收-${suffix}`,
      description: "自动验收后删除",
      category: "ANALYSIS",
      instructions: "准确复述任务资料中的验收标记，并简短总结页面内容。",
      avatarColor: "#6757E8",
      modelId: null,
      knowledgeBaseIds: [],
    },
  });
  assistantId = created.assistant.id;

  const uploadForm = new FormData();
  uploadForm.append(
    "file",
    new Blob([`项目验收标记：${fileMarker}\n请在最终结果中原样保留该标记。`], {
      type: "text/markdown",
    }),
    `task-tool-${suffix}.md`,
  );
  const uploaded = await request("/api/files", {
    token,
    method: "POST",
    body: uploadForm,
  });
  cleanupAttachmentIds.push(uploaded.attachment.id);
  const added = await request(`/api/ai/assistants/${assistantId}/files`, {
    token,
    method: "POST",
    body: { attachmentId: uploaded.attachment.id, origin: "UPLOAD" },
  });

  await request(`/api/ai/assistants/${assistantId}/browser/permission`, {
    token,
    method: "PUT",
    body: { enabled: true, allowScreenshot: true, allowInteraction: false },
  });

  const taskResult = await request(`/api/ai/assistants/${assistantId}/tasks`, {
    token,
    method: "POST",
    body: {
      title: `读取健康页-${suffix}`,
      prompt: "读取授权文件和页面，先输出文件中的验收标记，再用一句话说明页面是否健康。",
      scheduleType: "ONCE",
      scheduledFor: new Date(Date.now() + 10 * 60_000).toISOString(),
      enabled: true,
      fileIds: [added.file.id],
      browserAction: "SCREENSHOT",
      browserUrl: "http://127.0.0.1:3000/api/health",
    },
  });
  assert.deepEqual(taskResult.task.fileIds, [added.file.id]);
  assert.equal(taskResult.task.browserAction, "SCREENSHOT");

  await request(`/api/ai/assistants/${assistantId}/tasks/${taskResult.task.id}/run`, {
    token,
    method: "POST",
  });
  const { run } = await waitForTask(token, assistantId, taskResult.task.id);
  assert.equal(run.toolSummary.files.status, "USED");
  assert.equal(run.toolSummary.browser.status, "SUCCEEDED");
  assert.equal(run.toolSummary.browser.action, "SCREENSHOT");
  assert.ok(run.browserRunId, "任务执行应关联受控浏览器记录");
  assert.ok(run.toolSummary.browser.artifactFileId, "页面截图应进入助理文件工作区");

  const messages = await request(`/api/ai/assistants/${assistantId}/messages`, { token });
  const resultMessage = messages.messages.find((message) => message.id === run.resultMessageId);
  assert.ok(resultMessage, "任务结果消息应写回助理对话");
  assert.match(resultMessage.content, new RegExp(fileMarker));
  const taskInputMessage = messages.messages.find(
    (message) => message.role === "USER" && message.content.includes(taskResult.task.title),
  );
  assert.ok(
    taskInputMessage?.referencedFiles.some((file) => file.id === added.file.id),
    "任务输入消息应保留本次明确授权的文件引用",
  );

  const browserRuns = await request(`/api/ai/assistants/${assistantId}/browser/runs`, { token });
  const browserRun = browserRuns.runs.find((candidate) => candidate.id === run.browserRunId);
  const screenshotAttachmentId = browserRun?.steps[1]?.artifact?.attachment.id;
  if (screenshotAttachmentId) cleanupAttachmentIds.push(screenshotAttachmentId);
  assert.equal(browserRun?.status, "SUCCEEDED");
  assert.deepEqual(
    browserRun.steps.map((step) => step.action),
    ["OPEN", "SCREENSHOT"],
  );
  assert.ok(
    browserRun.steps.every((step) => step.status === "SUCCEEDED" && step.confirmedAt === null),
    "预授权的只读步骤应成功留痕，且不伪装成人工逐步确认",
  );
  assert.ok(browserRun.steps[1]?.artifact, "截图步骤应保留可下载的文件引用");

  console.log(
    "NearChat assistant task tools smoke passed: explicit file, screenshot, model reply and browser audit are healthy",
  );
  if (keepFixtures) console.log(`Acceptance fixture retained: assistantId=${assistantId}`);
} finally {
  if (!keepFixtures && assistantId && token) {
    await request(`/api/ai/assistants/${assistantId}`, {
      token,
      method: "DELETE",
    }).catch(() => undefined);
  }
  for (const attachmentId of keepFixtures ? [] : cleanupAttachmentIds) {
    if (token) {
      await request(`/api/files/${attachmentId}`, {
        token,
        method: "DELETE",
      }).catch(() => undefined);
    }
  }
}
