import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AiAssistant, AiAssistantMessage, AiCapabilities } from "../types";
import { AssistantCenterDialog } from "./AssistantCenterDialog";

const assistant: AiAssistant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "分析搭档",
  description: "帮我理清复杂信息",
  category: "ANALYSIS",
  instructions: "先归纳事实，再给出判断。",
  avatarColor: "#2F9D83",
  modelId: null,
  model: null,
  knowledgeBaseIds: [],
  messageCount: 0,
  lastMessageAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
};

const capabilities: AiCapabilities = {
  enabled: true,
  status: "READY",
  reason: "AI 已就绪，可使用 1 个对话模型",
  features: {
    knowledgeManagement: true,
    knowledgeIndexing: true,
    knowledgeSearch: true,
    knowledgeAnswer: true,
    personalAssistants: true,
  },
  provider: {
    chatModel: "gpt-test",
    embeddingModel: "embedding-test",
    embeddingDimensions: 1024,
  },
};

const modelResult = {
  models: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "通用模型",
      providerModel: "gpt-test",
      isDefault: true,
    },
  ],
  selectedModelId: "22222222-2222-4222-8222-222222222222",
  defaultModelId: "22222222-2222-4222-8222-222222222222",
};

describe("AssistantCenterDialog", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(api, "aiAssistants").mockResolvedValue({ assistants: [assistant] });
    vi.spyOn(api, "aiModels").mockResolvedValue(modelResult);
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({ knowledgeBases: [] });
    vi.spyOn(api, "aiAssistantMessages").mockResolvedValue({ messages: [] });
  });

  afterEach(() => vi.restoreAllMocks());

  it("加载独立助理时间线并发送一轮真实 API 对话", async () => {
    const user = userEvent.setup();
    const createdAt = "2026-08-14T09:20:00.000Z";
    const resultMessages: AiAssistantMessage[] = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        assistantId: assistant.id,
        role: "USER",
        content: "帮我分析这件事",
        model: null,
        sources: [],
        createdAt,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        assistantId: assistant.id,
        role: "ASSISTANT",
        content: "可以，先从已知事实开始。",
        model: modelResult.models[0]!,
        sources: [],
        createdAt,
      },
    ];
    vi.spyOn(api, "sendAiAssistantMessage").mockResolvedValue({ messages: resultMessages });

    render(<AssistantCenterDialog capabilities={capabilities} onClose={vi.fn()} />);
    const composer = await screen.findByPlaceholderText("给 分析搭档 发消息");
    await user.type(composer, "帮我分析这件事");
    await user.click(screen.getByRole("button", { name: "发送给智能助理" }));

    await waitFor(() =>
      expect(api.sendAiAssistantMessage).toHaveBeenCalledWith(assistant.id, "帮我分析这件事"),
    );
    expect(await screen.findByText("可以，先从已知事实开始。")).toBeTruthy();
  });

  it("无助理时可从预设打开配置并创建", async () => {
    const user = userEvent.setup();
    vi.mocked(api.aiAssistants).mockResolvedValueOnce({ assistants: [] });
    vi.spyOn(api, "createAiAssistant").mockResolvedValue({
      assistant: { ...assistant, name: "项目分析师" },
    });

    render(<AssistantCenterDialog capabilities={capabilities} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /创建第一个助理/ }));
    const nameInput = screen.getByRole("textbox", { name: "名称" });
    await user.clear(nameInput);
    await user.type(nameInput, "项目分析师");
    await user.click(screen.getByRole("button", { name: "创建助理" }));

    await waitFor(() =>
      expect(api.createAiAssistant).toHaveBeenCalledWith(
        expect.objectContaining({ name: "项目分析师", category: "GENERAL", modelId: null }),
      ),
    );
  });
});
