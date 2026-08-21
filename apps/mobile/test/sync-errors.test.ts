import assert from "node:assert/strict";
import test from "node:test";
import { shouldRecoverPullCursor, SyncHttpError } from "../src/sync-errors.ts";

test("pull 仅按结构化 409 状态触发一次 bootstrap 恢复", () => {
  const expiredCursor = new SyncHttpError(409, "文案可变化", { code: "CURSOR_OUT_OF_RANGE" });
  assert.equal(expiredCursor.status, 409);
  assert.equal(shouldRecoverPullCursor(expiredCursor, false), true);
  assert.equal(shouldRecoverPullCursor(expiredCursor, true), false);
  assert.equal(shouldRecoverPullCursor(new SyncHttpError(401, "未认证", null), false), false);
  assert.equal(shouldRecoverPullCursor(new Error("409 只是文案"), false), false);
});
