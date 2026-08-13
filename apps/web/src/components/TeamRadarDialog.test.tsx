import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Conversation, TeamRadar } from "../types";
import { TeamRadarDialog } from "./TeamRadarDialog";

const activeConversation: Conversation = {
  id: "conversation-active",
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
  lastMessage: {
    type: "TEXT",
    text: "设计稿已经更新",
    createdAt: "2026-08-13T10:30:00.000Z",
    senderId: "user-alice",
    senderName: "林小满",
    recalled: false,
  },
  unreadCount: 0,
};

const unreadConversation: Conversation = {
  ...activeConversation,
  id: "conversation-unread",
  type: "DIRECT",
  title: "周远",
  ownerId: null,
  peer: {
    id: "user-zhou",
    username: "zhou",
    displayName: "周远",
    avatarColor: "#2fae91",
    avatarUrl: null,
  },
  memberCount: 2,
  unreadCount: 3,
};

const radar: TeamRadar = {
  generatedAt: "2026-08-13T10:35:00.000Z",
  dayStartedAt: "2026-08-12T16:00:00.000Z",
  totalMemberCount: 3,
  onlineMembers: [
    {
      id: "user-admin",
      username: "admin",
      displayName: "管理员",
      avatarColor: "#6757e8",
      avatarUrl: null,
      status: null,
    },
    {
      id: "user-alice",
      username: "alice",
      displayName: "林小满",
      avatarColor: "#e76f88",
      avatarUrl: null,
      status: {
        text: "专注中",
        emoji: "🎯",
        expiresAt: "2099-08-13T12:00:00.000Z",
      },
    },
  ],
  todayMessageCount: 8,
  activeConversations: [
    {
      conversationId: activeConversation.id,
      messageCount: 8,
      lastActivityAt: "2026-08-13T10:30:00.000Z",
      lastMessage: {
        type: "TEXT",
        text: "设计稿已经更新",
        senderName: "林小满",
      },
    },
  ],
  unreadConversations: [
    {
      conversationId: unreadConversation.id,
      unreadCount: 3,
      latestUnreadAt: "2026-08-13T10:31:00.000Z",
      lastMessage: {
        type: "TEXT",
        text: "请确认交付时间",
        senderName: "周远",
      },
    },
  ],
};

describe("TeamRadarDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("汇总协作信号并从活动卡片直达会话", async () => {
    vi.spyOn(api, "teamRadar").mockResolvedValue(radar);
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <TeamRadarDialog
        conversations={[activeConversation, unreadConversation]}
        currentUserId="user-admin"
        onClose={onClose}
        onOpenConversation={onOpenConversation}
      />,
    );

    expect(await screen.findByText("人当前在线")).toBeTruthy();
    expect(screen.getAllByText("今天 8 条消息")).toHaveLength(2);
    expect(screen.getByText("专注中")).toBeTruthy();
    expect(screen.getByText("3 条待读")).toBeTruthy();
    expect(screen.getByText("林小满: 设计稿已经更新")).toBeTruthy();
    expect(screen.getByText(/不统计个人产出/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /项目讨论/ }));

    expect(onOpenConversation).toHaveBeenCalledWith(activeConversation.id);
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.teamRadar).toHaveBeenCalledOnce();
  });

  it("今天无消息且全部已读时展示完整零状态", async () => {
    vi.spyOn(api, "teamRadar").mockResolvedValue({
      ...radar,
      todayMessageCount: 0,
      activeConversations: [],
      unreadConversations: [],
    });
    render(
      <TeamRadarDialog
        conversations={[]}
        currentUserId="user-admin"
        onClose={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(await screen.findByText("今天还很安静")).toBeTruthy();
    expect(screen.getByText("消息已经全部读完")).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "刷新团队雷达" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
