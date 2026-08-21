import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_INSTRUCTIONS_MAX,
  ASSISTANT_MESSAGE_MAX,
  ASSISTANT_NAME_MAX,
  expiresAtForMemory,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  SHORT_TERM_MEMORY_TTL_MS,
  validateAssistantDraft,
  validateAssistantMessage,
  validateMemoryDraft,
} from "../src/entity-limits.ts";

test("记忆边界与服务端 title=120/content=10000 对齐", () => {
  assert.equal(
    validateMemoryDraft("标".repeat(MEMORY_TITLE_MAX), "文".repeat(MEMORY_CONTENT_MAX)),
    null,
  );
  assert.match(validateMemoryDraft("标".repeat(MEMORY_TITLE_MAX + 1), "内容") ?? "", /120/);
  assert.match(validateMemoryDraft("标题", "文".repeat(MEMORY_CONTENT_MAX + 1)) ?? "", /10000/);
});

test("短期记忆默认七天到期且已有到期时间保持稳定", () => {
  const nowMs = Date.parse("2026-08-21T00:00:00.000Z");
  assert.equal(
    expiresAtForMemory("SHORT_TERM", null, nowMs),
    new Date(nowMs + SHORT_TERM_MEMORY_TTL_MS).toISOString(),
  );
  assert.equal(
    expiresAtForMemory("SHORT_TERM", "2026-08-22T00:00:00.000Z", nowMs),
    "2026-08-22T00:00:00.000Z",
  );
  assert.equal(expiresAtForMemory("LONG_TERM", "2026-08-22T00:00:00.000Z", nowMs), null);
});

test("助理名称、说明和消息边界与服务端一致", () => {
  assert.equal(
    validateAssistantDraft(
      "名".repeat(ASSISTANT_NAME_MAX),
      "指".repeat(ASSISTANT_INSTRUCTIONS_MAX),
    ),
    null,
  );
  assert.match(validateAssistantDraft("名".repeat(ASSISTANT_NAME_MAX + 1), "说明") ?? "", /80/);
  assert.match(
    validateAssistantDraft("名称", "指".repeat(ASSISTANT_INSTRUCTIONS_MAX + 1)) ?? "",
    /6000/,
  );
  assert.equal(validateAssistantMessage("消".repeat(ASSISTANT_MESSAGE_MAX)), null);
  assert.match(validateAssistantMessage("消".repeat(ASSISTANT_MESSAGE_MAX + 1)) ?? "", /50000/);
});
