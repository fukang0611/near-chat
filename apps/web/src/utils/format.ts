import type { Conversation } from "../types";

const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 集中维护界面中的时间和文件大小格式，避免不同视图出现细微差异。 */
export function formatClock(value: string | null | undefined): string {
  return value ? clockFormatter.format(new Date(value)) : "";
}

export function formatSidebarTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatClock(value);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";

  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days < 7) {
    return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

export function formatMessageDay(value: string): string {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return "今天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

export function isSameCalendarDay(left: string, right: string): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatConversationPreview(conversation: Conversation): string {
  const message = conversation.lastMessage;
  if (!message) return "开始你们的第一段对话";
  if (message.text) return message.text;
  if (message.type === "IMAGE") return "[图片]";
  if (message.type === "FILE") return "[附件]";
  return "新消息";
}
