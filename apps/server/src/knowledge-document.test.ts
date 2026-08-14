import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  extractKnowledgeDocument,
  knowledgeDocumentKind,
  normalizeExtractedText,
  parseDelimitedRows,
  supportsKnowledgeDocument,
} from "./knowledge/document-extractor.js";
import { parseTesseractTsv } from "./knowledge/ocr-extractor.js";

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
  assert.equal(knowledgeDocumentKind("项目计划.xlsx", "application/octet-stream"), "xlsx");
  assert.equal(supportsKnowledgeDocument("照片.png", "image/png"), true);
  assert.equal(supportsKnowledgeDocument("压缩包.zip", "application/zip"), false);
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
  assert.deepEqual(result, {
    text: "标题\n\n团队知识内容",
    kind: "text",
    details: { method: "TEXT" },
  });
});

test("unsupported binary files fail before entering the embedding service", async () => {
  await assert.rejects(
    extractKnowledgeDocument(Buffer.from([0, 1, 2]), "压缩包.zip", "application/zip"),
    /暂不支持此文件格式/,
  );
});

test("CSV extraction preserves quoted delimiters and worksheet semantics", async () => {
  const source = '姓名,备注\r\n张三,"第一行, 包含逗号\n第二行"';
  assert.deepEqual(parseDelimitedRows(source, ","), [
    ["姓名", "备注"],
    ["张三", "第一行, 包含逗号\n第二行"],
  ]);
  const result = await extractKnowledgeDocument(Buffer.from(source), "客户.csv", "text/csv");
  assert.match(result.text, /【工作表：客户】/);
  assert.match(result.text, /【表头】姓名 ｜ 备注/);
  assert.match(result.text, /【第 2 行】张三 ｜ 第一行, 包含逗号 第二行/);
  assert.deepEqual(result.details, {
    method: "SPREADSHEET",
    worksheetCount: 1,
    rowCount: 2,
    cellCount: 4,
  });
});

test("XLSX extraction keeps worksheet names, headers and row values", async () => {
  const workbook = new ExcelJS.Workbook();
  const release = workbook.addWorksheet("发布计划");
  release.addRow(["版本", "负责人", "状态"]);
  release.addRow(["v1.2", "林小满", "准备发布"]);
  const risks = workbook.addWorksheet("风险清单");
  risks.addRow(["风险", "级别"]);
  risks.addRow(["内网带宽", "中"]);
  const bytes = await workbook.xlsx.writeBuffer();

  const result = await extractKnowledgeDocument(
    Buffer.from(new Uint8Array(bytes)),
    "计划.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(result.text, /【工作表：发布计划】/);
  assert.match(result.text, /【表头】版本 ｜ 负责人 ｜ 状态/);
  assert.match(result.text, /【第 2 行】v1.2 ｜ 林小满 ｜ 准备发布/);
  assert.match(result.text, /【工作表：风险清单】/);
  assert.deepEqual(result.details, {
    method: "SPREADSHEET",
    worksheetCount: 2,
    rowCount: 4,
    cellCount: 10,
  });
});

test("Tesseract TSV parser restores line boundaries and confidence", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t95\tNearChat",
    "5\t1\t1\t1\t1\t2\t12\t0\t10\t10\t85\t局域网",
    "5\t1\t1\t1\t2\t1\t0\t14\t10\t10\t90\t协作",
  ].join("\n");
  assert.deepEqual(parseTesseractTsv(tsv), {
    text: "NearChat 局域网\n协作",
    confidence: 90,
  });
});
