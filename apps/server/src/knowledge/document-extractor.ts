import path from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { config } from "../config.js";
import {
  extractImageWithOcr,
  extractPdfWithOcr,
  type OcrExtractionResult,
} from "./ocr-extractor.js";

export type KnowledgeDocumentKind = "text" | "markdown" | "html" | "json" | "spreadsheet" | "ocr";

export type KnowledgeExtractionMethod =
  "TEXT" | "MARKDOWN" | "HTML" | "JSON" | "PDF_TEXT" | "DOCX" | "SPREADSHEET" | "OCR";

export interface KnowledgeExtractionDetails {
  method: KnowledgeExtractionMethod;
  pageCount?: number;
  processedPages?: number;
  averageConfidence?: number | null;
  truncated?: boolean;
  worksheetCount?: number;
  rowCount?: number;
  cellCount?: number;
}

export interface ExtractedKnowledgeDocument {
  text: string;
  kind: KnowledgeDocumentKind;
  details: KnowledgeExtractionDetails;
}

type DetectedDocumentKind =
  Exclude<KnowledgeDocumentKind, "ocr"> | "pdf" | "docx" | "xlsx" | "image";

const plainExtensions = new Set([
  ".txt",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".css",
  ".sql",
]);
const ocrImageExtensions = new Set([".png", ".jpg", ".jpeg"]);

function extension(name: string): string {
  return path.extname(name).toLocaleLowerCase("en-US");
}

export function knowledgeDocumentKind(
  name: string,
  contentType: string,
): DetectedDocumentKind | null {
  const ext = extension(name);
  const mime = contentType.toLocaleLowerCase("en-US");
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    return "docx";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === ".xlsx"
  ) {
    return "xlsx";
  }
  if (mime === "text/csv" || ext === ".csv" || ext === ".tsv") return "spreadsheet";
  if (ocrImageExtensions.has(ext) || mime === "image/png" || mime === "image/jpeg") {
    return "image";
  }
  if (mime === "application/json" || ext === ".json") return "json";
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return "html";
  if (mime === "text/markdown" || ext === ".md" || ext === ".mdx") return "markdown";
  if (mime.startsWith("text/") || plainExtensions.has(ext)) return "text";
  return null;
}

export function supportsKnowledgeDocument(name: string, contentType: string): boolean {
  return knowledgeDocumentKind(name, contentType) !== null;
}

export function isOcrImageDocument(name: string, contentType: string): boolean {
  return knowledgeDocumentKind(name, contentType) === "image";
}

/** 保留段落边界，同时清掉二进制空字符和异常长空白，提升切片与检索质量。 */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function validateLength(text: string): string {
  if (!text) throw new Error("文档中没有可索引的文字");
  if (text.length > config.ai.knowledge.maxExtractedChars) {
    throw new Error(
      `文档提取文本超过 ${config.ai.knowledge.maxExtractedChars.toLocaleString("zh-CN")} 字符限制`,
    );
  }
  return text;
}

/** 解析 CSV/TSV 的引号、双引号转义和单元格内换行。 */
export function parseDelimitedRows(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cleanCell(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function trimTrailingEmptyCells(values: string[]): string[] {
  const result = values.map(cleanCell);
  while (result.length > 0 && !result[result.length - 1]) result.pop();
  return result;
}

function structuredWorksheetText(
  name: string,
  rows: string[][],
  totals: { rowCount: number; cellCount: number },
): string {
  const nonEmptyRows = rows
    .map(trimTrailingEmptyCells)
    .filter((row) => row.some((cell) => Boolean(cell)));
  if (nonEmptyRows.length === 0) return "";
  const lines = [`【工作表：${cleanCell(name) || "未命名"}】`];
  nonEmptyRows.forEach((row, index) => {
    totals.rowCount += 1;
    totals.cellCount += row.filter(Boolean).length;
    if (totals.cellCount > config.ai.knowledge.spreadsheetMaxCells) {
      throw new Error(
        `表格有效单元格超过 ${config.ai.knowledge.spreadsheetMaxCells.toLocaleString("zh-CN")} 个限制`,
      );
    }
    lines.push(`${index === 0 ? "【表头】" : `【第 ${index + 1} 行】`}${row.join(" ｜ ")}`);
  });
  return lines.join("\n");
}

function spreadsheetResult(sections: string[], rowCount: number, cellCount: number) {
  const populatedSections = sections.filter(Boolean);
  return {
    text: validateLength(normalizeExtractedText(populatedSections.join("\n\n"))),
    kind: "spreadsheet" as const,
    details: {
      method: "SPREADSHEET" as const,
      worksheetCount: populatedSections.length,
      rowCount,
      cellCount,
    },
  };
}

async function extractXlsx(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4.x 的声明仍把输入写成 ArrayBuffer；复制一次可兼容 Node 22 的泛型 Buffer。
  await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
  const totals = { rowCount: 0, cellCount: 0 };
  const sections: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        while (values.length < columnNumber - 1) values.push("");
        values.push(cell.text);
      });
      rows.push(values);
    });
    const section = structuredWorksheetText(worksheet.name, rows, totals);
    if (section) sections.push(section);
  });
  return spreadsheetResult(sections, totals.rowCount, totals.cellCount);
}

function extractDelimited(buffer: Buffer, name: string): ExtractedKnowledgeDocument {
  const delimiter = extension(name) === ".tsv" ? "\t" : ",";
  const totals = { rowCount: 0, cellCount: 0 };
  const section = structuredWorksheetText(
    path.basename(name, path.extname(name)),
    parseDelimitedRows(buffer.toString("utf8"), delimiter),
    totals,
  );
  return spreadsheetResult([section], totals.rowCount, totals.cellCount);
}

function ocrResult(result: OcrExtractionResult): ExtractedKnowledgeDocument {
  return {
    text: validateLength(normalizeExtractedText(result.text)),
    kind: "ocr",
    details: {
      method: "OCR",
      pageCount: result.pageCount,
      processedPages: result.processedPages,
      averageConfidence: result.averageConfidence,
      truncated: result.truncated,
    },
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractedKnowledgeDocument> {
  // PDF.js 会转移并释放输入 ArrayBuffer；保留原 Buffer 供扫描件后续交给 Poppler。
  const data = Uint8Array.from(buffer);
  const parser = new PDFParse({ data });
  let nativeText = "";
  let pageCount = 0;
  try {
    // 关闭 pdf-parse 自动插入的“第 N 页”连接符，避免把框架元信息误判为正文。
    const result = await parser.getText({ pageJoiner: "" });
    nativeText = normalizeExtractedText(result.text);
    pageCount = result.total;
  } finally {
    await parser.destroy();
  }
  if (
    config.ai.knowledge.ocr.enabled &&
    nativeText.length < config.ai.knowledge.ocr.pdfFallbackTextChars
  ) {
    try {
      return ocrResult(await extractPdfWithOcr(buffer, pageCount || 1, config.ai.knowledge.ocr));
    } catch (error) {
      // 有少量可用文本时，OCR 运行时缺失不应让原本可索引的 PDF 失效。
      if (!nativeText) throw error;
    }
  }
  if (!nativeText && !config.ai.knowledge.ocr.enabled) {
    throw new Error("扫描版 PDF 需要启用 OCR 后才能建立索引");
  }
  return {
    text: validateLength(nativeText),
    kind: "text",
    details: { method: "PDF_TEXT", pageCount },
  };
}

/**
 * 文档解析完全在 NearChat 服务进程及其本地 OCR 运行时内完成；原文件不会发送给
 * 模型服务，嵌入模型只接收切片文本。OCR 缺失只影响图片和扫描件，不影响普通文档。
 */
export async function extractKnowledgeDocument(
  buffer: Buffer,
  name: string,
  contentType: string,
): Promise<ExtractedKnowledgeDocument> {
  const detected = knowledgeDocumentKind(name, contentType);
  if (!detected) {
    throw new Error("暂不支持此文件格式，请使用 PDF、DOCX、XLSX、图片或文本文件");
  }
  if (detected === "pdf") return extractPdf(buffer);
  if (detected === "xlsx") return extractXlsx(buffer);
  if (detected === "spreadsheet") return extractDelimited(buffer, name);
  if (detected === "image") {
    if (!config.ai.knowledge.ocr.enabled) throw new Error("图片文字识别功能当前未启用");
    if (buffer.byteLength > config.ai.knowledge.ocr.maxImageBytes) {
      throw new Error(
        `OCR 图片不能超过 ${Math.floor(config.ai.knowledge.ocr.maxImageBytes / 1024 / 1024)} MB`,
      );
    }
    return ocrResult(await extractImageWithOcr(buffer, extension(name), config.ai.knowledge.ocr));
  }
  if (detected === "docx") {
    const text = normalizeExtractedText((await mammoth.extractRawText({ buffer })).value);
    return { text: validateLength(text), kind: "text", details: { method: "DOCX" } };
  }
  const text = validateLength(normalizeExtractedText(buffer.toString("utf8")));
  const method = {
    text: "TEXT",
    markdown: "MARKDOWN",
    html: "HTML",
    json: "JSON",
  }[detected] as KnowledgeExtractionMethod;
  return { text, kind: detected, details: { method } };
}
