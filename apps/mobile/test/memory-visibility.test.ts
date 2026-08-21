import assert from "node:assert/strict";
import test from "node:test";
import { isVisiblePrivateMemory } from "../src/memory-visibility.ts";

const active = {
  scope: "PRIVATE",
  status: "ACTIVE",
  expiresAt: null,
};

test("本地记忆检索只允许私人、活跃且未过期的数据", () => {
  const now = Date.parse("2026-08-21T00:00:00.000Z");
  assert.equal(isVisiblePrivateMemory(active, now), true);
  assert.equal(isVisiblePrivateMemory({ ...active, scope: "CONVERSATION" }, now), false);
  assert.equal(isVisiblePrivateMemory({ ...active, status: "ARCHIVED" }, now), false);
  assert.equal(
    isVisiblePrivateMemory({ ...active, expiresAt: "2026-08-20T23:59:59.999Z" }, now),
    false,
  );
  assert.equal(
    isVisiblePrivateMemory({ ...active, expiresAt: "2026-08-21T00:00:00.001Z" }, now),
    true,
  );
  assert.equal(isVisiblePrivateMemory({ ...active, expiresAt: "not-a-date" }, now), false);
});
