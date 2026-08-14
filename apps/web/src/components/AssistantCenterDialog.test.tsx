import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type {
  AiAssistant,
  AiAssistantFile,
  AiAssistantMessage,
  AiAssistantTask,
  AiCapabilities,
} from "../types";
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
    messageActions: true,
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

const workspaceFile: AiAssistantFile = {
  id: "66666666-6666-4666-8666-666666666666",
  assistantId: assistant.id,
  origin: "CHAT",
  sourceMessageId: null,
  attachment: {
    id: "77777777-7777-4777-8777-777777777777",
    originalName: "项目计划.md",
    contentType: "text/markdown",
    sizeBytes: 256,
  },
  processable: true,
  createdAt: "2026-08-14T08:30:00.000Z",
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
    vi.spyOn(api, "aiAssistantFiles").mockResolvedValue({ files: [] });
    vi.spyOn(api, "aiAssistantTasks").mockResolvedValue({ tasks: [] });
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
      expect(api.sendAiAssistantMessage).toHaveBeenCalledWith(assistant.id, "帮我分析这件事", []),
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

  it("只把用户在当前一轮勾选的工作区文件交给助理", async () => {
    const user = userEvent.setup();
    vi.mocked(api.aiAssistantFiles).mockResolvedValueOnce({ files: [workspaceFile] });
    const resultMessages: AiAssistantMessage[] = [
      {
        id: "88888888-8888-4888-8888-888888888888",
        assistantId: assistant.id,
        role: "USER",
        content: "提炼计划中的负责人",
        model: null,
        sources: [],
        referencedFiles: [workspaceFile],
        generatedFiles: [],
        createdAt: "2026-08-14T09:30:00.000Z",
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        assistantId: assistant.id,
        role: "ASSISTANT",
        content: "负责人是林小满。",
        model: modelResult.models[0]!,
        sources: [],
        referencedFiles: [],
        generatedFiles: [],
        createdAt: "2026-08-14T09:30:01.000Z",
      },
    ];
    vi.spyOn(api, "sendAiAssistantMessage").mockResolvedValue({ messages: resultMessages });

    render(<AssistantCenterDialog capabilities={capabilities} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "引用助理文件" }));
    await user.click(await screen.findByText("项目计划.md"));
    await user.type(screen.getByPlaceholderText("给 分析搭档 发消息"), "提炼计划中的负责人");
    await user.click(screen.getByRole("button", { name: "发送给智能助理" }));

    await waitFor(() =>
      expect(api.sendAiAssistantMessage).toHaveBeenCalledWith(assistant.id, "提炼计划中的负责人", [
        workspaceFile.id,
      ]),
    );
    expect(await screen.findByText("负责人是林小满。")).toBeTruthy();
  });

  it("可以查看文件工作区并把助理回复显式保存为文件", async () => {
    const user = userEvent.setup();
    const reply: AiAssistantMessage = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assistantId: assistant.id,
      role: "ASSISTANT",
      content: "这是整理后的项目摘要。",
      model: modelResult.models[0]!,
      sources: [],
      referencedFiles: [],
      generatedFiles: [],
      createdAt: "2026-08-14T09:40:00.000Z",
    };
    const generatedFile: AiAssistantFile = {
      ...workspaceFile,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      origin: "GENERATED",
      sourceMessageId: reply.id,
      attachment: {
        ...workspaceFile.attachment,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        originalName: "项目摘要.md",
      },
    };
    vi.mocked(api.aiAssistantMessages).mockResolvedValueOnce({ messages: [reply] });
    vi.mocked(api.aiAssistantFiles).mockResolvedValueOnce({ files: [workspaceFile] });
    vi.spyOn(api, "saveAiAssistantMessageFile").mockResolvedValue({ file: generatedFile });

    render(<AssistantCenterDialog capabilities={capabilities} onClose={vi.fn()} />);
    await screen.findByText(reply.content);
    await user.click(screen.getByRole("button", { name: "将这条回复保存为文件" }));
    const nameInput = screen.getByRole("textbox", { name: "文件名" });
    await user.clear(nameInput);
    await user.type(nameInput, "项目摘要");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(api.saveAiAssistantMessageFile).toHaveBeenCalledWith(assistant.id, reply.id, {
        format: "MARKDOWN",
        name: "项目摘要",
      }),
    );
    expect(await screen.findByText("项目摘要.md")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByText("项目计划.md")).toBeTruthy();
  });

  it("可以在助理内创建一次性后台任务", async () => {
    const user = userEvent.setup();
    const scheduledFor = new Date(Date.now() + 30 * 60_000);
    const local = new Date(scheduledFor.getTime() - scheduledFor.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
    const task: AiAssistantTask = {
      id: "55555555-5555-4555-8555-555555555555",
      assistantId: assistant.id,
      title: "整理项目摘要",
      prompt: "总结今天的重要进展和待办。",
      scheduleType: "ONCE",
      enabled: true,
      nextRunAt: scheduledFor.toISOString(),
      runRequested: false,
      lastRunAt: null,
      lastStatus: "NEVER",
      lastError: null,
      runCount: 0,
      recentRuns: [],
      createdAt: "2026-08-14T08:00:00.000Z",
      updatedAt: "2026-08-14T08:00:00.000Z",
    };
    vi.spyOn(api, "createAiAssistantTask").mockResolvedValue({ task });

    render(<AssistantCenterDialog capabilities={capabilities} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "任务" }));
    await user.click(await screen.findByRole("button", { name: /创建第一个任务/ }));
    await user.type(screen.getByRole("textbox", { name: "任务名称" }), task.title);
    await user.type(screen.getByRole("textbox", { name: "交给助理的任务内容" }), task.prompt);
    fireEvent.change(screen.getByLabelText("首次执行"), { target: { value: local } });
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() =>
      expect(api.createAiAssistantTask).toHaveBeenCalledWith(
        assistant.id,
        expect.objectContaining({
          title: task.title,
          prompt: task.prompt,
          scheduleType: "ONCE",
          enabled: true,
        }),
      ),
    );
    expect(await screen.findByText(task.title)).toBeTruthy();
  });
});
