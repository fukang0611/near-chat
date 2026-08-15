import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type {
  AiAssistant,
  AiAssistantReminder,
  AiAssistantTask,
  AiAssistantThread,
} from "../types";
import { AssistantSchedulePanel } from "./AssistantSchedulePanel";

const assistant: AiAssistant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "日程管家",
  description: "整理计划与提醒",
  category: "PLANNING",
  instructions: "按时间整理事务。",
  avatarColor: "#6757E8",
  modelId: null,
  model: null,
  knowledgeBaseIds: [],
  toolGrants: { crossConversationSearch: false, privateMemoryRead: false },
  messageCount: 0,
  lastMessageAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
};

const thread: AiAssistantThread = {
  id: "22222222-2222-4222-8222-222222222222",
  assistantId: assistant.id,
  title: "项目推进",
  archived: false,
  isDefault: true,
  messageCount: 0,
  lastMessageAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
};

function makeReminder(overrides: Partial<AiAssistantReminder> = {}): AiAssistantReminder {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    assistantId: assistant.id,
    threadId: thread.id,
    threadTitle: thread.title,
    threadArchived: false,
    title: "确认阶段验收",
    note: "带上测试结果",
    scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    status: "PENDING",
    completedAt: null,
    notifiedAt: null,
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<AiAssistantTask> = {}): AiAssistantTask {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    assistantId: assistant.id,
    threadId: thread.id,
    title: "生成每日进展",
    prompt: "汇总今天的完成事项。",
    scheduleType: "DAILY",
    fileIds: [],
    browserAction: "NONE",
    browserUrl: null,
    enabled: true,
    nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    runRequested: false,
    lastRunAt: null,
    lastStatus: "NEVER",
    lastError: null,
    runCount: 0,
    recentRuns: [],
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(onNotice = vi.fn()) {
  return {
    onNotice,
    ...render(
      <AssistantSchedulePanel
        assistant={assistant}
        threads={[thread]}
        selectedThreadId={thread.id}
        refreshVersion={0}
        onNotice={onNotice}
        onOpenThread={() => undefined}
        onOpenTask={() => undefined}
      />,
    ),
  };
}

describe("AssistantSchedulePanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "aiAssistantSchedule").mockResolvedValue({ tasks: [], reminders: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("统一展示提醒和自动任务的下一次执行", async () => {
    const reminder = makeReminder({ status: "DUE" });
    const task = makeTask();
    vi.mocked(api.aiAssistantSchedule).mockResolvedValue({ tasks: [task], reminders: [reminder] });

    renderPanel();

    expect(await screen.findByText(reminder.title)).toBeTruthy();
    expect(screen.getByText(task.title)).toBeTruthy();
    expect(screen.getByText("1 条到期")).toBeTruthy();
    expect(screen.getByText("每天")).toBeTruthy();
  });

  it("创建提醒并立即加入当前日程", async () => {
    const user = userEvent.setup();
    const reminder = makeReminder({ title: "准备演示材料" });
    vi.spyOn(api, "createAiAssistantReminder").mockResolvedValue({ reminder });
    const { onNotice } = renderPanel();
    const scheduledAt = new Date(Date.now() + 45 * 60_000);
    const localScheduledAt = new Date(
      scheduledAt.getTime() - scheduledAt.getTimezoneOffset() * 60_000,
    )
      .toISOString()
      .slice(0, 16);

    await user.click(screen.getByRole("button", { name: "新建提醒" }));
    await user.type(screen.getByLabelText("提醒名称"), reminder.title);
    fireEvent.change(screen.getByLabelText("时间"), {
      target: { value: localScheduledAt },
    });
    await user.type(screen.getByLabelText(/备注/), reminder.note);
    await user.click(screen.getByRole("button", { name: "保存提醒" }));

    await waitFor(() =>
      expect(api.createAiAssistantReminder).toHaveBeenCalledWith(
        assistant.id,
        expect.objectContaining({
          threadId: thread.id,
          title: reminder.title,
          note: reminder.note,
        }),
      ),
    );
    expect(await screen.findByText(reminder.title)).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith("success", "提醒已创建");
  });

  it("支持完成、推迟提醒以及暂停自动任务", async () => {
    const user = userEvent.setup();
    const reminder = makeReminder();
    const task = makeTask();
    vi.mocked(api.aiAssistantSchedule).mockResolvedValue({ tasks: [task], reminders: [reminder] });
    vi.spyOn(api, "updateAiAssistantReminder").mockImplementation(
      async (_assistantId, _reminderId, input) => ({
        reminder: makeReminder({
          scheduledAt: input.scheduledAt ?? reminder.scheduledAt,
          status: input.completed ? "COMPLETED" : "PENDING",
          completedAt: input.completed ? new Date().toISOString() : null,
        }),
      }),
    );
    vi.spyOn(api, "updateAiAssistantTask").mockResolvedValue({
      task: makeTask({ enabled: false }),
    });
    renderPanel();

    await screen.findByText(reminder.title);
    await user.click(screen.getByRole("button", { name: "10 分钟" }));
    await waitFor(() =>
      expect(api.updateAiAssistantReminder).toHaveBeenCalledWith(
        assistant.id,
        reminder.id,
        expect.objectContaining({ scheduledAt: expect.any(String) }),
      ),
    );

    vi.mocked(api.updateAiAssistantReminder).mockClear();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() =>
      expect(api.updateAiAssistantReminder).toHaveBeenCalledWith(assistant.id, reminder.id, {
        completed: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() =>
      expect(api.updateAiAssistantTask).toHaveBeenCalledWith(assistant.id, task.id, {
        enabled: false,
      }),
    );
    expect(screen.getByText("已暂停")).toBeTruthy();
  });

  it("日历视图可以按日期筛选日程", async () => {
    const user = userEvent.setup();
    const reminder = makeReminder({ scheduledAt: new Date().toISOString() });
    vi.mocked(api.aiAssistantSchedule).mockResolvedValue({ tasks: [], reminders: [reminder] });
    renderPanel();

    await user.click(screen.getByRole("tab", { name: "日历" }));
    expect(screen.getByRole("button", { name: "上个月" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下个月" })).toBeTruthy();
    expect(await screen.findByText(reminder.title)).toBeTruthy();
  });
});
