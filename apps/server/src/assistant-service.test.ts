import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_HISTORY_LIMIT,
  buildAssistantConversation,
  buildAssistantInstructions,
  buildAssistantPrompt,
} from "./assistant/assistant-service.js";
import type { KnowledgeSource } from "./knowledge/knowledge-service.js";

const source: KnowledgeSource = {
  chunkId: "chunk-1",
  score: 0.92,
  excerpt: "发布前需要完成回归测试。",
  position: 2,
  document: {
    id: "document-1",
    name: "发布手册.md",
    attachment: {
      id: "attachment-1",
      originalName: "发布手册.md",
      contentType: "text/markdown",
      sizeBytes: 128,
    },
  },
};

test("personal assistant instructions preserve category and user-defined role", () => {
  const instructions = buildAssistantInstructions("PLANNING", "每次给出三步以内的计划");

  assert.match(instructions, /计划拆解/);
  assert.match(instructions, /用户自定义要求/);
  assert.match(instructions, /三步以内/);
});

test("knowledge sources are numbered and kept separate from the stored user text", () => {
  assert.equal(buildAssistantPrompt("今天怎么发布？", []), "今天怎么发布？");

  const prompt = buildAssistantPrompt("今天怎么发布？", [source]);
  assert.match(prompt, /用户消息：\n今天怎么发布/);
  assert.match(prompt, /\[1\] 文件：发布手册\.md，片段 3/);
  assert.match(prompt, /完成回归测试/);
});

test("assistant conversation only sends the latest bounded history to Mastra", () => {
  const history = Array.from({ length: ASSISTANT_HISTORY_LIMIT + 5 }, (_, index) => ({
    role: index % 2 === 0 ? ("USER" as const) : ("ASSISTANT" as const),
    content: `历史 ${index}`,
  }));

  const messages = buildAssistantConversation(history, "继续", []);
  assert.equal(messages.length, ASSISTANT_HISTORY_LIMIT + 1);
  assert.equal(messages[0]?.content, "历史 5");
  assert.deepEqual(messages.at(-1), { role: "user", content: "继续" });
});
