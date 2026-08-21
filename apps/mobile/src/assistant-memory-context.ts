import type { LocalAssistant, LocalMemory } from "./models";

export interface AssistantMemoryAugmentation {
  allowPrivateMemory: boolean;
  memories: LocalMemory[];
  instructions: string;
  sourceIds: string[];
  sources: Array<{ type: "MEMORY"; id: string; title: string }>;
}

interface ToolResultLike {
  output?: unknown;
}

/**
 * 私人记忆授权是 fail-closed 的：旧本地数据没有授权字段时也不会执行检索。
 * 调用方把真正的 search_local_memories 执行器延迟传入，便于证明拒绝分支没有 I/O。
 */
export async function prepareAssistantMemoryAugmentation(
  assistant: Pick<LocalAssistant, "instructions" | "toolGrants">,
  executeSearchTool: () => Promise<ToolResultLike>,
): Promise<AssistantMemoryAugmentation> {
  const allowPrivateMemory = assistant.toolGrants?.privateMemoryRead === true;
  if (!allowPrivateMemory) {
    return {
      allowPrivateMemory: false,
      memories: [],
      instructions: assistant.instructions,
      sourceIds: [],
      sources: [],
    };
  }

  const result = await executeSearchTool();
  const memories = Array.isArray(result.output) ? (result.output as LocalMemory[]) : [];
  const memoryContext = memories.length
    ? `\n\n仅可使用以下本地记忆作为补充；不要虚构未提供的信息：\n${memories
        .map((memory, index) => `${index + 1}. ${memory.title}：${memory.content}`)
        .join("\n")}`
    : "";
  return {
    allowPrivateMemory: true,
    memories,
    instructions: `${assistant.instructions}${memoryContext}`,
    sourceIds: memories.map((memory) => memory.id),
    sources: memories.map((memory) => ({ type: "MEMORY", id: memory.id, title: memory.title })),
  };
}
