import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultAssistantWorkspace,
  createMissingAssistantThreads,
} from "../src/assistant-defaults.ts";

const createdAt = "2026-08-21T00:00:00.000Z";

test("启动时为只写入助理的半成品工作区补出唯一默认线程", () => {
  const { assistant } = createDefaultAssistantWorkspace(createdAt, () => "assistant-a");
  const repairs = createMissingAssistantThreads([assistant], [], createdAt, () => "thread-a");

  assert.deepEqual(repairs, [
    {
      id: "thread-a",
      assistantId: "assistant-a",
      title: "默认对话",
      archived: false,
      isDefault: true,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  assert.deepEqual(createMissingAssistantThreads([assistant], repairs, createdAt), []);
});

test("已有归档默认线程时补活跃非默认线程，避免撞默认线程唯一约束", () => {
  const { assistant, thread } = createDefaultAssistantWorkspace(createdAt, () => "assistant-a");
  const repairs = createMissingAssistantThreads(
    [assistant],
    [{ ...thread, id: "archived-default", archived: true }],
    createdAt,
    () => "active-thread",
  );

  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.isDefault, false);
  assert.equal(repairs[0]?.archived, false);
});
