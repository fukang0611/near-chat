import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { config } from "../config.js";

export type KnowledgeDocumentKind = "text" | "markdown" | "html" | "json";

export interface ExtractedKnowledgeDocument {
  text: string;
  kind: KnowledgeDocumentKind;
}

const plainExtensions = new Set([
  ".txt",
  ".csv",
  ".tsv",
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

function extension(name: string): string {
  return path.extname(name).toLocaleLowerCase("en-US");
}

export function knowledgeDocumentKind(
  name: string,
  contentType: string,
): KnowledgeDocumentKind | "pdf" | "docx" | null {
  const ext = extension(name);
  const mime = contentType.toLocaleLowerCase("en-US");
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    return "docx";
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
  if (!text) throw new Error("文档中没有可索引的文字；扫描版 PDF 暂不支持 OCR");
  if (text.length > config.ai.knowledge.maxExtractedChars) {
    throw new Error(
      `文档提取文本超过 ${config.ai.knowledge.maxExtractedChars.toLocaleString("zh-CN")} 字符限制`,
    );
  }
  return text;
}

/**
 * 文档解析在 NearChat 进程内完成，原文件不会发送给模型服务；模型只接收切片文本。
 * 第一阶段覆盖团队最常用的 PDF、DOCX、Markdown、网页、JSON 与纯文本格式。
 */
export async function extractKnowledgeDocument(
  buffer: Buffer,
  name: string,
  contentType: string,
): Promise<ExtractedKnowledgeDocument> {
  const kind = knowledgeDocumentKind(name, contentType);
  if (!kind) throw new Error("暂不支持此文件格式，请使用 PDF、DOCX、Markdown 或文本文件");

  let text: string;
  let documentKind: KnowledgeDocumentKind = "text";
  if (kind === "pdf") {
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const parser = new PDFParse({ data });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } else if (kind === "docx") {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else {
    text = buffer.toString("utf8");
    documentKind = kind;
  }

  return {
    text: validateLength(normalizeExtractedText(text)),
    kind: documentKind,
  };
}
