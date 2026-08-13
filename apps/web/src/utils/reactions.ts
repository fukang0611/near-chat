import type { MessageReaction } from "../types";

export const MESSAGE_REACTION_OPTIONS = [
  { emoji: "👍", label: "赞" },
  { emoji: "❤️", label: "喜欢" },
  { emoji: "😂", label: "哈哈" },
  { emoji: "🎉", label: "庆祝" },
  { emoji: "👀", label: "在看" },
  { emoji: "✨", label: "灵光" },
] as const;

export type MessageReactionEmoji = (typeof MESSAGE_REACTION_OPTIONS)[number]["emoji"];

export function reactionLabel(emoji: string): string {
  return MESSAGE_REACTION_OPTIONS.find((option) => option.emoji === emoji)?.label ?? "回应";
}

export function reactionTooltip(reaction: MessageReaction): string {
  const names = reaction.users.map((user) => user.displayName).join("、");
  return names ? `${names} · ${reactionLabel(reaction.emoji)}` : reactionLabel(reaction.emoji);
}
