import type { MessageKind } from "../types";

export function messageKindFromContentType(contentType: string | null): MessageKind {
  if (!contentType) return "TEXT";
  if (contentType.startsWith("image/")) return "IMAGE";
  if (contentType.startsWith("audio/")) return "AUDIO";
  return "FILE";
}
