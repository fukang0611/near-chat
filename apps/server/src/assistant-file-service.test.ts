import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_FILE_LIMIT,
  ASSISTANT_MESSAGE_FILE_LIMIT,
  allocateAssistantFileContexts,
  normalizeGeneratedFileName,
} from "./assistant/assistant-file-service.js";

test("generated assistant file names stay local, bounded and format-specific", () => {
  assert.equal(normalizeGeneratedFileName("../周报草稿.txt", "MARKDOWN"), "周报草稿.md");
  assert.equal(normalizeGeneratedFileName("\\团队\\结果.md", "TEXT"), "结果.txt");
  assert.equal(normalizeGeneratedFileName("\n\r", "MARKDOWN"), "__.md");
  assert.ok(normalizeGeneratedFileName("很长".repeat(200), "TEXT").length <= 184);
});

test("assistant workspace limits keep explicit references bounded", () => {
  assert.equal(ASSISTANT_FILE_LIMIT, 30);
  assert.equal(ASSISTANT_MESSAGE_FILE_LIMIT, 5);
});

test("large selected files share the prompt budget instead of hiding later files", () => {
  const contexts = allocateAssistantFileContexts(
    [
      { assistantFileId: "one", name: "one.md", text: "一".repeat(100) },
      { assistantFileId: "two", name: "two.md", text: "二".repeat(100) },
    ],
    80,
  );

  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.content.length, 40);
  assert.equal(contexts[1]?.content.length, 40);
  assert.ok(contexts.every((context) => context.truncated));
});
