import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ChatFilePage, Conversation, MessageFavorite } from "../types";
import { MessageAssetsDialog } from "./MessageAssetsDialog";

const conversation: Conversation = {
  id: "3a096ce0-b99b-47d5-b42a-da33972c841d",
  type: "GROUP",
  title: "项目讨论",
  avatarColor: "#6757e8",
  avatarUrl: null,
  ownerId: "user-admin",
  expiresAt: null,
  peer: null,
  members: [],
  memberCount: 3,
  onlineMemberCount: 2,
  lastMessage: null,
  unreadCount: 0,
};

const filePage: ChatFilePage = {
  files: [
    {
      attachment: {
        id: "d4ff1ce6-f70e-4bc1-bdb0-74f55a71f260",
        originalName: "迭代计划.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
      },
      category: "FILE",
      messageId: "76d5d6bc-2a8d-4028-91ba-62213da210f3",
      conversationId: conversation.id,
      senderId: "user-alice",
      senderName: "林小满",
      messageText: "这是本周的迭代计划",
      createdAt: "2026-08-13T10:30:00.000Z",
    },
  ],
  total: 1,
  totalBytes: 2048,
  offset: 0,
  hasMore: false,
};

const favorite: MessageFavorite = {
  id: "f17e81a0-aa7a-4ce4-b79e-73fd5944bb8d",
  sourceMessageId: "76d5d6bc-2a8d-4028-91ba-62213da210f3",
  sourceConversationId: conversation.id,
  sourceConversationTitle: conversation.title,
  sourceSenderId: "user-alice",
  sourceSenderName: "林小满",
  sourceSenderAvatarColor: "#e76f88",
  sourceSenderAvatarUrl: null,
  type: "TEXT",
  textContent: "请收藏这条产品决策",
  messageCreatedAt: "2026-08-13T10:30:00.000Z",
  createdAt: "2026-08-13T10:35:00.000Z",
  attachments: [],
  sourceAvailable: true,
};

describe("MessageAssetsDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("汇总聊天文件并可定位到原消息", async () => {
    vi.spyOn(api, "chatFiles").mockResolvedValue(filePage);
    const onOpenMessage = vi.fn();
    render(
      <MessageAssetsDialog
        conversations={[conversation]}
        onClose={vi.fn()}
        onOpenMessage={onOpenMessage}
      />,
    );

    expect(await screen.findAllByText("迭代计划.pdf")).toHaveLength(2);
    expect(screen.getByText("这是本周的迭代计划")).toBeTruthy();
    expect(screen.getByText("2.0 KB · 林小满")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "定位 迭代计划.pdf 的原消息" }));
    expect(onOpenMessage).toHaveBeenCalledWith(
      conversation.id,
      "76d5d6bc-2a8d-4028-91ba-62213da210f3",
    );
  });

  it("切换图片筛选后重新向服务端请求", async () => {
    const chatFiles = vi.spyOn(api, "chatFiles").mockResolvedValue({
      ...filePage,
      files: [],
      total: 0,
      totalBytes: 0,
    });
    render(
      <MessageAssetsDialog
        conversations={[conversation]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    await screen.findByText("这里还没有聊天文件");
    await userEvent.click(screen.getByRole("button", { name: "图片" }));

    await waitFor(() =>
      expect(chatFiles).toHaveBeenLastCalledWith(expect.objectContaining({ category: "IMAGE" })),
    );
  });

  it("收藏页展示消息快照并经二次确认移除", async () => {
    vi.spyOn(api, "chatFiles").mockResolvedValue(filePage);
    vi.spyOn(api, "messageFavorites").mockResolvedValue({ favorites: [favorite] });
    const deleteFavorite = vi.spyOn(api, "deleteFavorite").mockResolvedValue(undefined);
    const onFavoriteRemoved = vi.fn();
    render(
      <MessageAssetsDialog
        conversations={[conversation]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
        onFavoriteRemoved={onFavoriteRemoved}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "我的收藏" }));
    expect(await screen.findByText("请收藏这条产品决策")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "取消收藏 林小满 的消息" }));
    await userEvent.click(screen.getByRole("button", { name: "确认移除" }));

    expect(deleteFavorite).toHaveBeenCalledWith(favorite.id);
    expect(onFavoriteRemoved).toHaveBeenCalledWith(favorite);
    expect(screen.queryByText("请收藏这条产品决策")).toBeNull();
  });
});
