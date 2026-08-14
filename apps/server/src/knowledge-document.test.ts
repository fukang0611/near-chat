import assert from "node:assert/strict";
import test from "node:test";
import {
  extractKnowledgeDocument,
  knowledgeDocumentKind,
  normalizeExtractedText,
  supportsKnowledgeDocument,
} from "./knowledge/document-extractor.js";

test("knowledge document format detection uses MIME type and safe extension fallback", () => {
  assert.equal(knowledgeDocumentKind("手册.pdf", "application/octet-stream"), "pdf");
  assert.equal(
    knowledgeDocumentKind(
      "计划.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "docx",
  );
  assert.equal(knowledgeDocumentKind("README.md", "text/markdown"), "markdown");
  assert.equal(supportsKnowledgeDocument("照片.png", "image/png"), false);
});

test("plain text extraction preserves paragraphs and removes unsafe control characters", async () => {
  assert.equal(
    normalizeExtractedText("\uFEFF第一段\r\n\r\n\u0000第二段   内容"),
    "第一段\n\n第二段 内容",
  );
  const result = await extractKnowledgeDocument(
    Buffer.from("标题\r\n\r\n团队知识内容"),
    "说明.txt",
    "text/plain",
  );
  assert.deepEqual(result, { text: "标题\n\n团队知识内容", kind: "text" });
});

test("unsupported binary files fail before entering the embedding service", async () => {
  await assert.rejects(
    extractKnowledgeDocument(Buffer.from([0, 1, 2]), "图片.png", "image/png"),
    /暂不支持此文件格式/,
  );
});
