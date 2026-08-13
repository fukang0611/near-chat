export const MESSAGE_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✨"] as const;

export type MessageReactionEmoji = (typeof MESSAGE_REACTION_EMOJIS)[number];

/** 服务端只接受产品内置反应，避免任意文本借反应接口进入消息时间线。 */
export function isMessageReactionEmoji(value: string): value is MessageReactionEmoji {
  return MESSAGE_REACTION_EMOJIS.some((emoji) => emoji === value);
}
