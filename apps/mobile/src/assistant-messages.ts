import type { LocalAssistantMessage } from "./models";

/**
 * 端侧回复使用 Keystore 中的 OpenAI 兼容模型名，不是服务端 ai_model_configs UUID。
 * 因此同步字段 modelId 必须为空，不能把本地生成错误归因到服务端模型目录。
 */
export function createDeviceGeneratedAssistantMessage(input: {
  id: string;
  assistantId: string;
  threadId: string;
  content: string;
  sources: Array<Record<string, unknown>>;
  createdAt: string;
}): LocalAssistantMessage {
  return {
    ...input,
    role: "ASSISTANT",
    modelId: null,
    revision: 0,
  };
}
