import type { Attachment, Message } from "../types";

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".md",
  ".mdx",
  ".html",
  ".htm",
  ".json",
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

/** 与服务端文档解析器保持同一格式边界，用于隐藏必然失败的纯二进制入口。 */
export function supportsMessageAiAttachment(attachment: Attachment): boolean {
  const mime = attachment.contentType.toLocaleLowerCase("en-US");
  if (
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    mime === "application/json" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return true;
  }
  const normalizedName = attachment.originalName.toLocaleLowerCase("en-US");
  return [...DOCUMENT_EXTENSIONS].some((extension) => normalizedName.endsWith(extension));
}

export function canProcessMessageWithAi(message: Message): boolean {
  return Boolean(
    message.textContent?.trim() || message.attachments.some(supportsMessageAiAttachment),
  );
}
