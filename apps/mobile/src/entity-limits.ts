import type { LocalMemory } from "./models";

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_CONTENT_MAX = 10_000;
export const ASSISTANT_NAME_MAX = 80;
export const ASSISTANT_INSTRUCTIONS_MAX = 6_000;
export const ASSISTANT_MESSAGE_MAX = 50_000;
export const SHORT_TERM_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function validateMemoryDraft(title: string, content: string): string | null {
  if (!title || !content) return "记忆标题和内容不能为空";
  if (title.length > MEMORY_TITLE_MAX) return `记忆标题不能超过 ${MEMORY_TITLE_MAX} 个字符`;
  if (content.length > MEMORY_CONTENT_MAX) return `记忆内容不能超过 ${MEMORY_CONTENT_MAX} 个字符`;
  return null;
}

export function expiresAtForMemory(
  tier: LocalMemory["tier"],
  existingExpiresAt: string | null,
  nowMs: number,
): string | null {
  if (tier === "LONG_TERM") return null;
  return existingExpiresAt ?? new Date(nowMs + SHORT_TERM_MEMORY_TTL_MS).toISOString();
}

export function validateAssistantDraft(name: string, instructions: string): string | null {
  if (!name || !instructions) return "助理名称和说明不能为空";
  if (name.length > ASSISTANT_NAME_MAX) return `助理名称不能超过 ${ASSISTANT_NAME_MAX} 个字符`;
  if (instructions.length > ASSISTANT_INSTRUCTIONS_MAX)
    return `助理说明不能超过 ${ASSISTANT_INSTRUCTIONS_MAX} 个字符`;
  return null;
}

export function validateAssistantMessage(content: string): string | null {
  if (!content) return "消息不能为空";
  if (content.length > ASSISTANT_MESSAGE_MAX) return `消息不能超过 ${ASSISTANT_MESSAGE_MAX} 个字符`;
  return null;
}
