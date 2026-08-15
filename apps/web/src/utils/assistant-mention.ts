/** 从公开可见的消息文本中移除首个助理标签，得到真正交给模型的用户请求。 */
export function assistantMentionPrompt(text: string, assistantName: string): string {
  const token = `@${assistantName}`;
  const index = text.indexOf(token);
  if (index < 0) return text.trim();
  return `${text.slice(0, index)}${text.slice(index + token.length)}`.trim();
}

export function removeAssistantMention(text: string, assistantName: string): string {
  const token = `@${assistantName}`;
  const index = text.indexOf(token);
  if (index < 0) return text;
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + token.length).trimStart();
  return [before, after].filter(Boolean).join(before && after ? " " : "");
}
