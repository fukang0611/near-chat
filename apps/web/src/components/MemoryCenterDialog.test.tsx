import type { MemoryCandidate, MemoryRecord } from "@near-chat/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { MemoryCenterDialog } from "./MemoryCenterDialog";

const memory: MemoryRecord = {
  id: "a0c323f4-d1a4-4e9a-9d12-193c258fc911",
  tier: "LONG_TERM",
  scope: "PRIVATE",
  conversationId: null,
  kind: "PROJECT",
  title: "NearChat 部署约定",
  content: "团队内部部署使用 PostgreSQL 和 MinIO。",
  importance: 4,
  revision: 1,
  sources: [
    {
      type: "MANUAL",
      id: null,
      conversationId: null,
      label: "用户手动创建",
      excerpt: null,
      createdAt: "2026-08-15T08:00:00.000Z",
    },
  ],
  expiresAt: null,
  createdAt: "2026-08-15T08:00:00.000Z",
  updatedAt: "2026-08-15T08:00:00.000Z",
};

const candidate: MemoryCandidate = {
  id: "61fda565-80ed-47ea-94bd-99f0e10b7eb1",
  kind: "NOTE",
  title: "周五下午发布",
  content: "周五下午发布，先完成离线包验收。",
  importance: 3,
  status: "PENDING",
  source: {
    type: "MESSAGE",
    id: "2cf752f5-da75-4387-bee6-148d63268e8a",
    conversationId: "5ff1427e-d6e7-454f-8a6e-f1e90009f3ae",
    label: "项目群 · 林小满",
    excerpt: "记住：周五下午发布，先完成离线包验收。",
    createdAt: "2026-08-15T08:20:00.000Z",
  },
  createdAt: "2026-08-15T08:20:01.000Z",
  updatedAt: "2026-08-15T08:20:01.000Z",
};

describe("MemoryCenterDialog", () => {
  beforeEach(() => {
    vi.spyOn(api, "memoryCandidates").mockResolvedValue({ candidates: [], total: 0 });
    vi.spyOn(api, "memorySettings").mockResolvedValue({
      settings: {
        explicitCaptureEnabled: true,
        semanticCaptureEnabled: false,
        semanticCaptureMessageThreshold: 20,
        semanticCaptureSilenceMinutes: 5,
        shortTermRetentionDays: 7,
        updatedAt: null,
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("加载并使用版本号修订长期记忆", async () => {
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [memory],
      total: 1,
      offset: 0,
      hasMore: false,
      searchMode: "KEYWORD",
    });
    const updatedMemory = {
      ...memory,
      title: "NearChat 离线部署约定",
      revision: 2,
      updatedAt: "2026-08-15T08:10:00.000Z",
    };
    const updateMemory = vi.spyOn(api, "updateMemory").mockResolvedValue({ memory: updatedMemory });

    render(<MemoryCenterDialog onClose={vi.fn()} />);

    expect(await screen.findByDisplayValue("NearChat 部署约定")).toBeTruthy();
    const title = screen.getByLabelText("标题");
    await userEvent.clear(title);
    await userEvent.type(title, "NearChat 离线部署约定");
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() =>
      expect(updateMemory).toHaveBeenCalledWith(
        memory.id,
        expect.objectContaining({
          title: "NearChat 离线部署约定",
          baseRevision: 1,
        }),
      ),
    );
    expect(await screen.findByText("REVISION 2")).toBeTruthy();
  });

  it("没有配置 AI 时仍可手动创建并遗忘记忆", async () => {
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [],
      total: 0,
      offset: 0,
      hasMore: false,
      searchMode: "KEYWORD",
    });
    vi.spyOn(api, "createMemory").mockResolvedValue({ memory });
    const forgetMemory = vi.spyOn(api, "forgetMemory").mockResolvedValue(undefined);

    render(<MemoryCenterDialog onClose={vi.fn()} />);
    expect(await screen.findByText("还没有长期记忆")).toBeTruthy();

    await userEvent.click(screen.getAllByRole("button", { name: "新建长期记忆" })[0]!);
    await userEvent.type(screen.getByLabelText("标题"), memory.title);
    await userEvent.type(screen.getByLabelText("记忆内容"), memory.content);
    await userEvent.click(screen.getByRole("button", { name: "保存记忆" }));

    expect(await screen.findByText("REVISION 1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "遗忘" }));
    await userEvent.click(screen.getByRole("button", { name: "确认遗忘" }));

    await waitFor(() => expect(forgetMemory).toHaveBeenCalledWith(memory.id));
    expect(screen.queryByDisplayValue(memory.title)).toBeNull();
  });

  it("短期记忆创建时显式携带 7 天层级", async () => {
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [],
      total: 0,
      offset: 0,
      hasMore: false,
      searchMode: "KEYWORD",
    });
    const shortMemory: MemoryRecord = {
      ...memory,
      tier: "SHORT_TERM",
      expiresAt: "2026-08-22T08:00:00.000Z",
    };
    const createMemory = vi.spyOn(api, "createMemory").mockResolvedValue({ memory: shortMemory });

    render(<MemoryCenterDialog onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "7 天短期" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "新建短期记忆" }).length).toBeGreaterThan(0),
    );
    await userEvent.click(screen.getAllByRole("button", { name: "新建短期记忆" })[0]!);
    await userEvent.type(screen.getByLabelText("标题"), "本周发布重点");
    await userEvent.type(screen.getByLabelText("记忆内容"), "先完成离线包验收");
    await userEvent.click(screen.getByRole("button", { name: "保存记忆" }));

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "SHORT_TERM", title: "本周发布重点" }),
    );
  });

  it("消息候选可确认成短期记忆", async () => {
    vi.mocked(api.memoryCandidates).mockResolvedValue({ candidates: [candidate], total: 1 });
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [],
      total: 0,
      offset: 0,
      hasMore: false,
      searchMode: "KEYWORD",
    });
    const accept = vi.spyOn(api, "acceptMemoryCandidate").mockResolvedValue({
      memory: { ...memory, tier: "SHORT_TERM", expiresAt: "2026-08-22T08:00:00.000Z" },
    });

    render(<MemoryCenterDialog onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /待确认/u }));
    expect(await screen.findByText(candidate.content)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "保留 7 天" }));

    await waitFor(() => expect(accept).toHaveBeenCalledWith(candidate.id, "SHORT_TERM"));
    expect(screen.queryByText(candidate.content)).toBeNull();
  });

  it("可开启智能整理并从候选定位原消息", async () => {
    vi.mocked(api.memoryCandidates).mockResolvedValue({ candidates: [candidate], total: 1 });
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [],
      total: 0,
      offset: 0,
      hasMore: false,
      searchMode: "KEYWORD",
    });
    const updateSettings = vi.spyOn(api, "updateMemorySettings").mockResolvedValue({
      settings: {
        explicitCaptureEnabled: true,
        semanticCaptureEnabled: true,
        semanticCaptureMessageThreshold: 20,
        semanticCaptureSilenceMinutes: 5,
        shortTermRetentionDays: 7,
        updatedAt: "2026-08-15T08:30:00.000Z",
      },
    });
    const onOpenMessage = vi.fn();

    render(<MemoryCenterDialog onClose={vi.fn()} onOpenMessage={onOpenMessage} />);
    await userEvent.click(screen.getByRole("tab", { name: /待确认/u }));
    await userEvent.click(screen.getByRole("switch", { name: "智能整理近期会话" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ semanticCaptureEnabled: true }),
    );

    await userEvent.click(screen.getByRole("button", { name: /原消息/u }));
    expect(onOpenMessage).toHaveBeenCalledWith(
      candidate.source.conversationId,
      candidate.source.id,
    );
  });
});
