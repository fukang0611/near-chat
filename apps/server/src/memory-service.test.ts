import assert from "node:assert/strict";
import test from "node:test";
import { escapeMemorySearchPattern } from "./memory-service.js";

test("记忆关键词把 ILIKE 通配符视为普通文本", () => {
  assert.equal(
    escapeMemorySearchPattern(String.raw`项目_完成度 90% \\ 路径`),
    String.raw`项目\_完成度 90\% \\\\ 路径`,
  );
});
