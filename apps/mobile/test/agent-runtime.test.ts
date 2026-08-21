import assert from "node:assert/strict";
import test from "node:test";
import { LocalAgentRuntime } from "../../../packages/agent-protocol/src/index.ts";

test("LocalAgentRuntime 使用注入传输并保留可追溯来源", async () => {
  const requests: unknown[] = [];
  const runtime = new LocalAgentRuntime(
    { baseUrl: "https://model.example/v1", apiKey: "secret", model: "local-model" },
    async (request) => {
      requests.push(request);
      return { status: 200, data: { choices: [{ message: { content: "完成" } }] } };
    },
  );
  const response = await runtime.generate({
    modelId: null,
    instructions: "只使用本地上下文",
    messages: [{ role: "user", content: "整理记录" }],
    toolContext: {
      requesterUserId: "local-user",
      assistantId: "assistant",
      invocationId: null,
      visibility: "PRIVATE_PREVIEW",
      allowedConversationIds: [],
      allowPrivateMemory: true,
    },
    sourceIds: ["memory-1", "memory-1"],
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(response.sourceIds, ["memory-1"]);
  assert.equal(response.text, "完成");
});

test("LocalAgentRuntime 只执行显式注入工具并封装失败", async () => {
  const runtime = new LocalAgentRuntime(
    { baseUrl: "https://model.example/v1", apiKey: "secret", model: "local-model" },
    async () => ({ status: 200, data: {} }),
    {
      search_local_memories: async (argumentsValue) => ({ query: argumentsValue.query, hits: 2 }),
      fail: async () => {
        throw new Error("工具失败");
      },
    },
  );
  assert.deepEqual(
    await runtime.executeTool({
      id: "call-1",
      name: "search_local_memories",
      arguments: { query: "发布" },
    }),
    {
      callId: "call-1",
      name: "search_local_memories",
      output: { query: "发布", hits: 2 },
    },
  );
  assert.match(
    (await runtime.executeTool({ id: "call-2", name: "unknown", arguments: {} })).error ?? "",
    /未授权或不存在/,
  );
  assert.equal(
    (await runtime.executeTool({ id: "call-3", name: "fail", arguments: {} })).error,
    "工具失败",
  );
});
