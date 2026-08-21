import type { LocalAssistant, LocalAssistantThread } from "./models";
import { DEFAULT_ASSISTANT_TOOL_GRANTS } from "@near-chat/domain";

export function createDefaultAssistantWorkspace(
  createdAt: string,
  idFactory: () => string = () => crypto.randomUUID(),
): { assistant: LocalAssistant; thread: LocalAssistantThread } {
  const assistant: LocalAssistant = {
    id: idFactory(),
    name: "本地助理",
    description: "只使用本机上下文的个人助理",
    category: "GENERAL",
    instructions: "你是用户的 NearChat 本地个人助理。回答简洁、准确；不确定时明确说明。",
    avatarColor: "#6757E8",
    modelId: null,
    toolGrants: { ...DEFAULT_ASSISTANT_TOOL_GRANTS },
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const thread: LocalAssistantThread = {
    id: idFactory(),
    assistantId: assistant.id,
    title: "默认对话",
    archived: false,
    isDefault: true,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
  return { assistant, thread };
}

/**
 * Room 中助理与线程分属两张表；进程在两次写入之间退出时，下一次启动必须能修复孤儿助理。
 * 已归档的默认线程仍占用服务端默认线程唯一约束，因此修复线程只在没有任何默认线程时设为默认。
 */
export function createMissingAssistantThreads(
  assistants: LocalAssistant[],
  threads: LocalAssistantThread[],
  createdAt: string,
  idFactory: () => string = () => crypto.randomUUID(),
): LocalAssistantThread[] {
  return assistants.flatMap((assistant) => {
    const assistantThreads = threads.filter((thread) => thread.assistantId === assistant.id);
    if (assistantThreads.some((thread) => !thread.archived)) return [];
    return [
      {
        id: idFactory(),
        assistantId: assistant.id,
        title: "默认对话",
        archived: false,
        isDefault: !assistantThreads.some((thread) => thread.isDefault),
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      },
    ];
  });
}
