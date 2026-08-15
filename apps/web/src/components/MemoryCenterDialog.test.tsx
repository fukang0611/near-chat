import type { MemoryRecord } from "@near-chat/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("MemoryCenterDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("加载并使用版本号修订长期记忆", async () => {
    vi.spyOn(api, "memories").mockResolvedValue({
      memories: [memory],
      total: 1,
      offset: 0,
      hasMore: false,
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
    });
    vi.spyOn(api, "createMemory").mockResolvedValue({ memory });
    const forgetMemory = vi.spyOn(api, "forgetMemory").mockResolvedValue(undefined);

    render(<MemoryCenterDialog onClose={vi.fn()} />);
    expect(await screen.findByText("还没有长期记忆")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "新建长期记忆" }));
    await userEvent.type(screen.getByLabelText("标题"), memory.title);
    await userEvent.type(screen.getByLabelText("记忆内容"), memory.content);
    await userEvent.click(screen.getByRole("button", { name: "保存记忆" }));

    expect(await screen.findByText("REVISION 1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "遗忘" }));
    await userEvent.click(screen.getByRole("button", { name: "确认遗忘" }));

    await waitFor(() => expect(forgetMemory).toHaveBeenCalledWith(memory.id));
    expect(screen.queryByDisplayValue(memory.title)).toBeNull();
  });
});
