import type { Message, MessageReply } from "../types";

export const MAX_MESSAGE_TEXT_LENGTH = 5_000;

/** AI、引用等外部结果写入草稿时统一守住编辑器容量，不静默截断用户内容。 */
export function appendMessageDraft(existing: string, addition: string): string | null {
  const current = existing.trimEnd();
  const next = current ? `${current}\n\n${addition}` : addition;
  return next.length <= MAX_MESSAGE_TEXT_LENGTH ? next : null;
}

/** 为引用卡片、通知和复制操作提供一致的消息摘要。 */
export function messageSummary(
  message: Pick<Message, "type" | "textContent" | "attachments" | "recalledAt">,
): string {
  if (message.recalledAt) return "消息已撤回";
  if (message.textContent) return message.textContent;
  const attachment = message.attachments[0];
  if (message.type === "AUDIO") return "[语音明信片]";
  if (attachment) return message.type === "IMAGE" ? "[图片]" : attachment.originalName;
  return message.type === "IMAGE" ? "[图片]" : message.type === "FILE" ? "[附件]" : "消息";
}

export function replySummary(reply: MessageReply): string {
  if (reply.recalled) return "消息已撤回";
  if (reply.textContent) return reply.textContent;
  if (reply.type === "AUDIO") return "[语音明信片]";
  if (reply.attachmentName) return reply.type === "IMAGE" ? "[图片]" : reply.attachmentName;
  return reply.type === "IMAGE" ? "[图片]" : reply.type === "FILE" ? "[附件]" : "消息";
}

export function toMessageReply(message: Message): MessageReply {
  return {
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    type: message.type,
    textContent: message.textContent,
    attachmentName: message.attachments[0]?.originalName ?? null,
    recalled: Boolean(message.recalledAt),
  };
}
