export type MessageKind = "TEXT" | "IMAGE" | "AUDIO" | "FILE";

/** 附件消息的业务类型由服务端保存的 MIME 决定，客户端声明不会直接进入消息表。 */
export function messageKindFromContentType(contentType: string | null): MessageKind {
  if (!contentType) return "TEXT";
  if (contentType.startsWith("image/")) return "IMAGE";
  if (contentType.startsWith("audio/")) return "AUDIO";
  return "FILE";
}
