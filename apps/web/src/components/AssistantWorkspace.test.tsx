import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type {
  AiAssistant,
  AiAssistantFile,
  AiAssistantMessage,
  AiAssistantTask,
  AiAssistantThread,
  AiCapabilities,
} from "../types";
import { AssistantWorkspace } from "./AssistantWorkspace";

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

function assistantThread(
  assistantId = assistant.id,
  overrides: Partial<AiAssistantThread> = {},
): AiAssistantThread {
  return {
    id:
      assistantId === assistant.id
        ? "abababab-abab-4bab-8bab-abababababab"
        : "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    assistantId,
    title: "默认对话",
    archived: false,
    isDefault: true,
    messageCount: 0,
    lastMessageAt: null,
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

const defaultThread = assistantThread();

function AssistantWorkspaceHarness() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <AssistantWorkspace
      capabilities={capabilities}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      onDirectoryChange={() => undefined}
      onMobileBack={() => undefined}
    />
  );
}

function SwitchingAssistantWorkspaceHarness({ assistants }: { assistants: AiAssistant[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(assistants[0]?.id ?? null);
  return (
    <>
      {assistants.map((item) => (
        <button type="button" key={item.id} onClick={() => setSelectedId(item.id)}>
          切换到 {item.name}
        </button>
      ))}
      <AssistantWorkspace
        capabilities={capabilities}
        selectedId={selectedId}
        onSelectedIdChange={setSelectedId}
        onDirectoryChange={() => undefined}
        onMobileBack={() => undefined}
      />
    </>
  );
}

describe("AssistantWorkspace", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(api, "aiAssistants").mockResolvedValue({ assistants: [assistant] });
    vi.spyOn(api, "aiModels").mockResolvedValue(modelResult);
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({ knowledgeBases: [] });
    vi.spyOn(api, "aiAssistantThreads").mockImplementation(async (assistantId) => ({
      threads: [assistantThread(assistantId)],
    }));
    vi.spyOn(api, "aiAssistantMessages").mockResolvedValue({ messages: [] });
    vi.spyOn(api, "aiAssistantFiles").mockResolvedValue({ files: [] });
    vi.spyOn(api, "aiAssistantTasks").mockResolvedValue({ tasks: [] });
    vi.spyOn(api, "aiAssistantSchedule").mockResolvedValue({ tasks: [], reminders: [] });
    vi.spyOn(api, "aiAssistantBrowserPermission").mockResolvedValue({
      permission: {
        assistantId: assistant.id,
        enabled: false,
        allowRead: true,
        allowScreenshot: false,
        allowInteraction: false,
        updatedAt: null,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("工作区通知会在阅读时间结束后自动收起", async () => {
    vi.useFakeTimers();
    vi.mocked(api.aiAssistants).mockRejectedValueOnce(new Error("浏览器工具授权保存失败"));

    render(<AssistantWorkspaceHarness />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("浏览器工具授权保存失败");

    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("加载独立助理时间线并发送一轮真实 API 对话", async () => {
    const user = userEvent.setup();
    const createdAt = "2026-08-14T09:20:00.000Z";
    const resultMessages: AiAssistantMessage[] = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        assistantId: assistant.id,
        threadId: defaultThread.id,
        role: "USER",
        content: "帮我分析这件事",
        model: null,
        sources: [],
        createdAt,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        assistantId: assistant.id,
        threadId: defaultThread.id,
        role: "ASSISTANT",
        content: "可以，先从已知事实开始。",
        model: modelResult.models[0]!,
        sources: [],
        createdAt,
      },
    ];
    vi.spyOn(api, "sendAiAssistantMessage").mockResolvedValue({ messages: resultMessages });

    render(<AssistantWorkspaceHarness />);
    const composer = await screen.findByPlaceholderText("给 分析搭档 发消息");
    await user.type(composer, "帮我分析这件事");
    await user.click(screen.getByRole("button", { name: "发送给智能助理" }));

    await waitFor(() =>
      expect(api.sendAiAssistantMessage).toHaveBeenCalledWith(
        assistant.id,
        defaultThread.id,
        "帮我分析这件事",
        [],
      ),
    );
    expect(await screen.findByText("可以，先从已知事实开始。")).toBeTruthy();
  });

  it("作为主工作区渲染并提供移动端返回入口", async () => {
    const onMobileBack = vi.fn();

    render(
      <AssistantWorkspace
        capabilities={capabilities}
        selectedId={assistant.id}
        onSelectedIdChange={() => undefined}
        onDirectoryChange={() => undefined}
        onMobileBack={onMobileBack}
      />,
    );

    expect(await screen.findByRole("region", { name: "智能助理工作区" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "智能助理" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "返回助理列表" }));
    expect(onMobileBack).toHaveBeenCalledOnce();
  });

  it("从主导航进入助理日程中心", async () => {
    const user = userEvent.setup();

    render(<AssistantWorkspaceHarness />);
    await user.click(await screen.findByRole("tab", { name: "日程" }));

    expect(await screen.findByRole("region", { name: "日程与提醒中心" })).toBeTruthy();
    expect(api.aiAssistantSchedule).toHaveBeenCalledWith(assistant.id);
  });

  it("切换助理时分别保留尚未发送的草稿", async () => {
    const user = userEvent.setup();
    const planningAssistant: AiAssistant = {
      ...assistant,
      id: "12121212-1212-4121-8121-121212121212",
      name: "计划管家",
      category: "PLANNING",
    };
    vi.mocked(api.aiAssistants).mockResolvedValueOnce({
      assistants: [assistant, planningAssistant],
    });

    render(<SwitchingAssistantWorkspaceHarness assistants={[assistant, planningAssistant]} />);
    const analysisComposer = await screen.findByPlaceholderText("给 分析搭档 发消息");
    await user.type(analysisComposer, "分析草稿");

    await user.click(screen.getByRole("button", { name: "切换到 计划管家" }));
    const planningComposer = await screen.findByPlaceholderText("给 计划管家 发消息");
    await user.type(planningComposer, "规划草稿");

    await user.click(screen.getByRole("button", { name: "切换到 分析搭档" }));
    expect(
      ((await screen.findByPlaceholderText("给 分析搭档 发消息")) as HTMLTextAreaElement).value,
    ).toBe("分析草稿");
  });

  it("同一助理可创建、切换和归档彼此隔离的对话", async () => {
    const user = userEvent.setup();
    const projectThread = assistantThread(assistant.id, {
      id: "dededede-dede-4ede-8ede-dededededede",
      title: "项目讨论",
      isDefault: false,
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z",
    });
    let threadDirectory = [defaultThread];
    vi.mocked(api.aiAssistantThreads).mockImplementation(async () => ({
      threads: threadDirectory,
    }));
    vi.spyOn(api, "createAiAssistantThread").mockImplementation(async () => {
      threadDirectory = [projectThread, ...threadDirectory];
      return { thread: projectThread };
    });
    vi.spyOn(api, "updateAiAssistantThread").mockImplementation(
      async (_assistantId, threadId, input) => {
        threadDirectory = threadDirectory.map((thread) =>
          thread.id === threadId ? { ...thread, ...input } : thread,
        );
        return { thread: threadDirectory.find((thread) => thread.id === threadId)! };
      },
    );

    render(<AssistantWorkspaceHarness />);
    const defaultComposer = await screen.findByPlaceholderText("给 分析搭档 发消息");
    await user.type(defaultComposer, "默认对话草稿");

    await user.click(screen.getByRole("button", { name: "新建助理对话" }));
    await user.type(screen.getByRole("textbox", { name: "新对话名称" }), projectThread.title);
    await user.click(screen.getByRole("button", { name: "保存对话名称" }));

    const projectComposer = await screen.findByPlaceholderText("给 分析搭档 发消息");
    expect((projectComposer as HTMLTextAreaElement).value).toBe("");
    await user.type(projectComposer, "项目对话草稿");

    await user.click(screen.getByRole("tab", { name: /默认对话/ }));
    expect(
      ((await screen.findByPlaceholderText("给 分析搭档 发消息")) as HTMLTextAreaElement).value,
    ).toBe("默认对话草稿");

    await user.click(screen.getByRole("tab", { name: /项目讨论/ }));
    await user.click(screen.getByRole("button", { name: `归档 ${projectThread.title}` }));
    await waitFor(() =>
      expect(api.updateAiAssistantThread).toHaveBeenCalledWith(assistant.id, projectThread.id, {
        archived: true,
      }),
    );
    expect(screen.queryByRole("tab", { name: /项目讨论/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "显示已归档对话" }));
    expect(await screen.findByRole("tab", { name: /项目讨论/ })).toBeTruthy();
  });

  it("无助理时可从预设打开配置并创建", async () => {
    const user = userEvent.setup();
    vi.mocked(api.aiAssistants).mockResolvedValueOnce({ assistants: [] });
    vi.spyOn(api, "createAiAssistant").mockResolvedValue({
      assistant: { ...assistant, name: "项目分析师" },
    });

    render(<AssistantWorkspaceHarness />);
    await user.click(await screen.findByRole("button", { name: /随身助理/ }));
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
        threadId: defaultThread.id,
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
        threadId: defaultThread.id,
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

    render(<AssistantWorkspaceHarness />);
    await user.click(await screen.findByRole("button", { name: "引用助理文件" }));
    await user.click(await screen.findByText("项目计划.md"));
    await user.type(screen.getByPlaceholderText("给 分析搭档 发消息"), "提炼计划中的负责人");
    await user.click(screen.getByRole("button", { name: "发送给智能助理" }));

    await waitFor(() =>
      expect(api.sendAiAssistantMessage).toHaveBeenCalledWith(
        assistant.id,
        defaultThread.id,
        "提炼计划中的负责人",
        [workspaceFile.id],
      ),
    );
    expect(await screen.findByText("负责人是林小满。")).toBeTruthy();
  });

  it("可以查看文件工作区并把助理回复显式保存为文件", async () => {
    const user = userEvent.setup();
    const reply: AiAssistantMessage = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assistantId: assistant.id,
      threadId: defaultThread.id,
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

    render(<AssistantWorkspaceHarness />);
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
    vi.mocked(api.aiAssistantFiles).mockResolvedValue({ files: [workspaceFile] });
    vi.mocked(api.aiAssistantBrowserPermission).mockResolvedValue({
      permission: {
        assistantId: assistant.id,
        enabled: true,
        allowRead: true,
        allowScreenshot: true,
        allowInteraction: false,
        updatedAt: "2026-08-14T08:10:00.000Z",
      },
    });
    const scheduledFor = new Date(Date.now() + 30 * 60_000);
    const local = new Date(scheduledFor.getTime() - scheduledFor.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
    const task: AiAssistantTask = {
      id: "55555555-5555-4555-8555-555555555555",
      assistantId: assistant.id,
      threadId: defaultThread.id,
      title: "整理项目摘要",
      prompt: "总结今天的重要进展和待办。",
      scheduleType: "ONCE",
      fileIds: [workspaceFile.id],
      browserAction: "SCREENSHOT",
      browserUrl: "https://intranet.example.com/status",
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

    render(<AssistantWorkspaceHarness />);
    await user.click(await screen.findByRole("tab", { name: "任务" }));
    await user.click(await screen.findByRole("button", { name: /创建第一个任务/ }));
    await user.type(screen.getByRole("textbox", { name: "任务名称" }), task.title);
    await user.type(screen.getByRole("textbox", { name: "交给助理的任务内容" }), task.prompt);
    fireEvent.change(screen.getByLabelText("首次执行"), { target: { value: local } });
    await user.click(screen.getByRole("button", { name: /项目计划\.md/ }));
    await user.click(screen.getByRole("button", { name: /保存截图/ }));
    await user.type(screen.getByRole("textbox", { name: /目标页面/ }), task.browserUrl!);
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() =>
      expect(api.createAiAssistantTask).toHaveBeenCalledWith(
        assistant.id,
        expect.objectContaining({
          title: task.title,
          threadId: defaultThread.id,
          prompt: task.prompt,
          scheduleType: "ONCE",
          enabled: true,
          fileIds: [workspaceFile.id],
          browserAction: "SCREENSHOT",
          browserUrl: task.browserUrl,
        }),
      ),
    );
    expect(await screen.findByText(task.title)).toBeTruthy();
    expect(screen.getByText("1 个文件")).toBeTruthy();
  });
});
