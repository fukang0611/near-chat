import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type {
  AiAssistant,
  AiAssistantBrowserPermission,
  AiAssistantBrowserRun,
  AiAssistantBrowserStep,
} from "../types";
import { AssistantBrowserPanel } from "./AssistantBrowserPanel";

const assistant: AiAssistant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "网页观察员",
  description: "读取内部页面",
  category: "ANALYSIS",
  instructions: "只整理事实。",
  avatarColor: "#2F9D83",
  modelId: null,
  model: null,
  knowledgeBaseIds: [],
  messageCount: 0,
  lastMessageAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
};

const disabledPermission: AiAssistantBrowserPermission = {
  assistantId: assistant.id,
  enabled: false,
  allowRead: true,
  allowScreenshot: false,
  allowInteraction: false,
  updatedAt: null,
};

const enabledPermission: AiAssistantBrowserPermission = {
  ...disabledPermission,
  enabled: true,
  allowScreenshot: true,
  allowInteraction: true,
  updatedAt: "2026-08-14T08:10:00.000Z",
};

function openStep(status: AiAssistantBrowserStep["status"]): AiAssistantBrowserStep {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    runId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    action: "OPEN",
    status,
    input: { url: "https://example.com/" },
    output: {},
    artifact: null,
    confirmedAt: status === "SUCCEEDED" ? "2026-08-14T08:20:00.000Z" : null,
    startedAt: status === "SUCCEEDED" ? "2026-08-14T08:20:00.000Z" : null,
    completedAt: status === "SUCCEEDED" ? "2026-08-14T08:20:01.000Z" : null,
    errorMessage: null,
    createdAt: "2026-08-14T08:19:00.000Z",
  };
}

function browserRun(status: AiAssistantBrowserRun["status"]): AiAssistantBrowserRun {
  const opened = status === "ACTIVE";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    assistantId: assistant.id,
    goal: "读取公告",
    startUrl: "https://example.com/",
    status,
    currentUrl: opened ? "https://example.com/" : null,
    pageTitle: opened ? "内部公告" : null,
    pageExcerpt: opened ? "本周五发布新版本。" : null,
    pageElements: opened
      ? [
          {
            ref: "e1",
            kind: "INPUT",
            label: "搜索公告",
            inputType: "text",
            href: null,
            disabled: false,
          },
        ]
      : [],
    openedAt: opened ? "2026-08-14T08:20:00.000Z" : null,
    completedAt: null,
    errorMessage: null,
    createdAt: "2026-08-14T08:19:00.000Z",
    updatedAt: "2026-08-14T08:20:01.000Z",
    steps: [openStep(opened ? "SUCCEEDED" : "AWAITING_CONFIRMATION")],
  };
}

describe("AssistantBrowserPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "aiAssistantBrowserPermission").mockResolvedValue({
      permission: disabledPermission,
    });
    vi.spyOn(api, "aiAssistantBrowserRuns").mockResolvedValue({ runs: [] });
  });

  afterEach(() => vi.restoreAllMocks());

  it("默认关闭，并在用户显式保存后才启用页面读取", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "updateAiAssistantBrowserPermission").mockResolvedValue({
      permission: enabledPermission,
    });

    render(
      <AssistantBrowserPanel assistant={assistant} onNotice={vi.fn()} onFilesChanged={vi.fn()} />,
    );
    expect(await screen.findByText("浏览器工具尚未启用")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /页面读取/ }));
    await user.click(screen.getByRole("button", { name: "保存授权" }));

    await waitFor(() =>
      expect(api.updateAiAssistantBrowserPermission).toHaveBeenCalledWith(assistant.id, {
        enabled: true,
        allowScreenshot: false,
        allowInteraction: false,
      }),
    );
    expect(await screen.findByText("新建执行")).toBeTruthy();
  });

  it("新建运行只生成待确认步骤，不会静默访问页面", async () => {
    const user = userEvent.setup();
    const pendingRun = browserRun("AWAITING_CONFIRMATION");
    const activeRun = browserRun("ACTIVE");
    vi.mocked(api.aiAssistantBrowserPermission).mockResolvedValueOnce({
      permission: enabledPermission,
    });
    vi.spyOn(api, "createAiAssistantBrowserRun").mockResolvedValue({ run: pendingRun });
    vi.spyOn(api, "confirmAiAssistantBrowserStep").mockResolvedValue({ run: activeRun });

    render(
      <AssistantBrowserPanel assistant={assistant} onNotice={vi.fn()} onFilesChanged={vi.fn()} />,
    );
    await user.type(await screen.findByPlaceholderText(/读取项目公告/), "读取公告");
    await user.type(
      screen.getByPlaceholderText("https://intranet.example.com"),
      "https://example.com",
    );
    await user.click(screen.getByRole("button", { name: "创建确认步骤" }));

    expect(await screen.findByText(/等待你的确认/)).toBeTruthy();
    expect(api.confirmAiAssistantBrowserStep).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认执行此步骤" }));
    await waitFor(() =>
      expect(api.confirmAiAssistantBrowserStep).toHaveBeenCalledWith(
        assistant.id,
        pendingRun.id,
        pendingRun.steps[0]!.id,
        undefined,
      ),
    );
  });

  it("填写内容只在确认请求发送，不进入准备步骤", async () => {
    const user = userEvent.setup();
    const activeRun = browserRun("ACTIVE");
    const fillStep: AiAssistantBrowserStep = {
      ...openStep("AWAITING_CONFIRMATION"),
      id: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      action: "FILL",
      input: { elementRef: "e1", elementLabel: "搜索公告", elementKind: "INPUT" },
    };
    const awaitingFill = {
      ...activeRun,
      status: "AWAITING_CONFIRMATION" as const,
      steps: [openStep("SUCCEEDED"), fillStep],
    };
    vi.mocked(api.aiAssistantBrowserPermission).mockResolvedValueOnce({
      permission: enabledPermission,
    });
    vi.mocked(api.aiAssistantBrowserRuns).mockResolvedValueOnce({ runs: [activeRun] });
    vi.spyOn(api, "prepareAiAssistantBrowserStep").mockResolvedValue({ run: awaitingFill });
    vi.spyOn(api, "confirmAiAssistantBrowserStep").mockResolvedValue({ run: activeRun });

    render(
      <AssistantBrowserPanel assistant={assistant} onNotice={vi.fn()} onFilesChanged={vi.fn()} />,
    );
    const actionSelect = await screen.findByLabelText("下一步");
    fireEvent.change(actionSelect, { target: { value: "FILL" } });
    await user.click(screen.getByRole("button", { name: "生成确认步骤" }));

    await waitFor(() =>
      expect(api.prepareAiAssistantBrowserStep).toHaveBeenCalledWith(assistant.id, activeRun.id, {
        action: "FILL",
        elementRef: "e1",
      }),
    );
    await user.type(await screen.findByPlaceholderText(/操作参数不落库/), "北辰计划");
    await user.click(screen.getByRole("button", { name: "确认执行此步骤" }));
    await waitFor(() =>
      expect(api.confirmAiAssistantBrowserStep).toHaveBeenCalledWith(
        assistant.id,
        activeRun.id,
        fillStep.id,
        "北辰计划",
      ),
    );
  });
});
