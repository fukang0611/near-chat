import assert from "node:assert/strict";
import test from "node:test";
import { extractExplicitMemoryHint, memoryCandidateTitle } from "./memory-service.js";

test("只提取明确的聊天记忆意图", () => {
  assert.equal(extractExplicitMemoryHint("记住：周五下午发布"), "周五下午发布");
  assert.equal(
    extractExplicitMemoryHint(" 请帮我记一下  客户习惯用 PDF 交付 "),
    "客户习惯用 PDF 交付",
  );
  assert.equal(extractExplicitMemoryHint("今天把发布计划确认一下"), null);
  assert.equal(extractExplicitMemoryHint("记住"), null);
});

test("候选标题压缩空白并保持列表可扫描", () => {
  assert.equal(memoryCandidateTitle("  周五\n下午发布  "), "周五 下午发布");
  const title = memoryCandidateTitle("这是一段需要被压缩成候选标题的长内容".repeat(8));
  assert.equal(title.length, 54);
  assert.match(title, /…$/u);
  assert.equal(memoryCandidateTitle("", "附件消息"), "附件消息");
});
