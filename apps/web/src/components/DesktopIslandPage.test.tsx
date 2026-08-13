import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Conversation, Message, User } from "../types";
import { DesktopIslandPage } from "./DesktopIslandPage";

vi.mock("../hooks/useRealtimeConnection", () => ({
  useRealtimeConnection: () => "connected",
}));

const currentUser: User = {
  id: "current-user",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6757e8",
  avatarUrl: null,
};

const peer: User = {
  id: "peer-user",
  username: "alice",
  displayName: "林小满",
  avatarColor: "#e46a84",
  avatarUrl: null,
  online: true,
};

const directConversation: Conversation = {
  id: "direct-one",
  type: "DIRECT",
  title: peer.displayName,
  avatarColor: peer.avatarColor,
  avatarUrl: null,
  ownerId: null,
  peer,
  members: [currentUser, peer],
  memberCount: 2,
  onlineMemberCount: 2,
  lastMessage: {
    type: "TEXT",
    text: "收到设计稿",
    createdAt: "2026-08-13T10:00:00.000Z",
    senderId: peer.id,
    senderName: peer.displayName,
    recalled: false,
  },
  unreadCount: 2,
};

function message(text: string, sender = peer): Message {
  return {
    id: `message-${text}`,
    conversationId: directConversation.id,
    senderId: sender.id,
    senderName: sender.displayName,
    senderAvatarColor: sender.avatarColor,
    senderAvatarUrl: sender.avatarUrl,
    clientMessageId: `client-${text}`,
    type: "TEXT",
    textContent: text,
    createdAt: "2026-08-13T10:00:00.000Z",
    recalledAt: null,
    recallableUntil: "2026-08-13T10:02:00.000Z",
    replyTo: null,
    attachments: [],
    receipt: { recipientCount: 1, deliveredCount: 1, readCount: 0 },
  };
}

describe("DesktopIslandPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "conversations").mockResolvedValue({ conversations: [directConversation] });
    vi.spyOn(api, "messages").mockResolvedValue({
      messages: [message("收到设计稿")],
      nextCursor: null,
      hasMore: false,
    });
    vi.spyOn(api, "markRead").mockResolvedValue({ unreadCount: 0 });
    Object.defineProperty(window, "nearChatDesktop", {
      configurable: true,
      value: {
        openMainWindow: vi.fn(),
        setDesktopIslandEnabled: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.classList.remove("desktop-island-body");
    Object.defineProperty(window, "nearChatDesktop", { configurable: true, value: undefined });
  });

  it("展示最近会话、未读与最新消息，并可跳回主窗口", async () => {
    const user = userEvent.setup();
    render(<DesktopIslandPage user={currentUser} onSessionInvalid={vi.fn()} />);

    expect(await screen.findByText("收到设计稿")).not.toBeNull();
    expect(screen.getByText("2 条未读")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "查看完整会话" }));
    expect(window.nearChatDesktop?.openMainWindow).toHaveBeenCalledWith("direct-one");
  });

  it("使用标准消息接口快速发送文本", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.spyOn(api, "sendMessage").mockImplementation(async (_, input) => ({
      message: {
        ...message(input.text ?? "", currentUser),
        clientMessageId: input.clientMessageId,
      },
    }));
    render(<DesktopIslandPage user={currentUser} onSessionInvalid={vi.fn()} />);

    const input = await screen.findByRole("textbox", { name: "浮岛消息" });
    await user.type(input, "浮岛快速回复");
    await user.click(screen.getByRole("button", { name: "发送浮岛消息" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toBe("direct-one");
    expect(sendMessage.mock.calls[0]?.[1].text).toBe("浮岛快速回复");
    expect(await screen.findByText("浮岛快速回复")).not.toBeNull();
  });

  it("闪聊到期后浮岛也进入只读状态", async () => {
    vi.mocked(api.conversations).mockResolvedValue({
      conversations: [
        {
          ...directConversation,
          id: "flash-one",
          type: "GROUP",
          title: "临时评审",
          peer: null,
          ownerId: currentUser.id,
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    render(<DesktopIslandPage user={currentUser} onSessionInvalid={vi.fn()} />);

    const input = await screen.findByRole("textbox", { name: "浮岛消息" });
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(input.getAttribute("placeholder")).toBe("闪聊已结束，只能查看历史消息");
    expect(screen.getAllByText(/闪聊已结束/).length).toBeGreaterThan(0);
  });
});
