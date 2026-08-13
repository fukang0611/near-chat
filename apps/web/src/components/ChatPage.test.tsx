import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Conversation, Message, User } from "../types";
import { ChatPage } from "./ChatPage";

vi.mock("../hooks/useRealtimeConnection", () => ({
  useRealtimeConnection: () => "connected",
}));

const currentUser: User = {
  id: "current-user",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6757E8",
  avatarUrl: null,
  role: "ADMIN",
};
const peerUser: User = {
  id: "peer-user",
  username: "zhouyuan",
  displayName: "周远",
  avatarColor: "#2fae91",
  avatarUrl: null,
  online: true,
  role: "USER",
};
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

function conversation(id: string, title: string): Conversation {
  return {
    id,
    type: "GROUP",
    title,
    avatarColor: "#D27B5A",
    avatarUrl: null,
    ownerId: currentUser.id,
    peer: null,
    members: [currentUser],
    memberCount: 1,
    onlineMemberCount: 1,
    lastMessage: null,
    unreadCount: 0,
  };
}

function directConversation(id: string): Conversation {
  return {
    id,
    type: "DIRECT",
    title: peerUser.displayName,
    avatarColor: peerUser.avatarColor,
    avatarUrl: peerUser.avatarUrl,
    ownerId: null,
    peer: peerUser,
    members: [currentUser, peerUser],
    memberCount: 2,
    onlineMemberCount: 2,
    lastMessage: null,
    unreadCount: 0,
  };
}

function message(conversationId: string, textContent: string): Message {
  return {
    id: `message-${conversationId}`,
    conversationId,
    senderId: currentUser.id,
    senderName: currentUser.displayName,
    senderAvatarColor: currentUser.avatarColor,
    senderAvatarUrl: null,
    clientMessageId: `client-${conversationId}`,
    type: "TEXT",
    textContent,
    createdAt: "2026-08-12T09:00:00.000Z",
    recalledAt: null,
    recallableUntil: "2026-08-12T09:02:00.000Z",
    replyTo: null,
    attachments: [],
    receipt: { recipientCount: 1, deliveredCount: 1, readCount: 1 },
  };
}

describe("ChatPage message scrolling", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    values.set("near-chat-notification-prompt:current-user", "handled");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (!this.classList.contains("message-scroll")) return 0;
        return this.querySelector(".messages-loading") ? 400 : 1_200;
      },
    });

    const conversations = [
      conversation("conversation-one", "第一会话"),
      conversation("conversation-two", "第二会话"),
      directConversation("conversation-direct"),
    ];
    vi.spyOn(api, "users").mockResolvedValue({ users: [peerUser] });
    vi.spyOn(api, "conversations").mockResolvedValue({ conversations });
    vi.spyOn(api, "messages").mockImplementation(async (conversationId) => ({
      messages: [message(conversationId, `${conversationId} 的最新消息`)],
      nextCursor: null,
      hasMore: false,
    }));
    // 模拟真实网络延迟：消息数组会先写入，加载占位稍后才会被真正消息替换。
    vi.spyOn(api, "markRead").mockImplementation(
      () =>
        new Promise((resolve) => {
          window.setTimeout(() => resolve({ unreadCount: 0 }), 20);
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "nearChatDesktop", {
      configurable: true,
      value: undefined,
    });
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
    } else {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("切换到消息条数相同的会话时仍定位到最新消息", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatPage
        user={currentUser}
        theme="light"
        onThemeChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    await screen.findByText("conversation-one 的最新消息");
    const messageScroll = container.querySelector<HTMLElement>(".message-scroll");
    expect(messageScroll?.scrollTop).toBe(1_200);

    if (messageScroll) messageScroll.scrollTop = 0;
    await user.click(screen.getByRole("button", { name: /第二会话/ }));
    await screen.findByText("conversation-two 的最新消息");

    await waitFor(() => expect(messageScroll?.scrollTop).toBe(1_200));
  });

  it("将联系人上的拖拽文本通过标准单聊消息链路直接发送", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "directConversation").mockResolvedValue({
      conversationId: "conversation-direct",
    });
    const sendMessage = vi
      .spyOn(api, "sendMessage")
      .mockImplementation(async (conversationId, input) => ({
        message: {
          ...message(conversationId, input.text ?? ""),
          id: "message-avatar-drop",
          clientMessageId: input.clientMessageId,
        },
      }));

    render(
      <ChatPage
        user={currentUser}
        theme="light"
        onThemeChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    await screen.findByText("conversation-one 的最新消息");
    await user.click(screen.getByRole("tab", { name: /联系人/ }));
    const target = screen.getByRole("button", { name: /周远/ });
    const dataTransfer = {
      types: ["text/plain"],
      files: [],
      dropEffect: "none",
      getData: () => "从头像直接发送",
    } as unknown as DataTransfer;

    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(api.directConversation).toHaveBeenCalledWith("peer-user"));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        "conversation-direct",
        expect.objectContaining({
          text: "从头像直接发送",
          attachmentIds: [],
        }),
      ),
    );
    expect(await screen.findByText("已投递给 周远")).toBeTruthy();
  });

  it("从在线单聊头部发送不落库的敲一下提醒", async () => {
    const user = userEvent.setup();
    const nudgeConversation = vi.spyOn(api, "nudgeConversation").mockResolvedValue(undefined);
    render(
      <ChatPage
        user={currentUser}
        theme="light"
        onThemeChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    await screen.findByText("conversation-one 的最新消息");
    await user.click(screen.getByRole("button", { name: /周远/ }));
    await user.click(await screen.findByRole("button", { name: "敲一下 周远" }));

    expect(nudgeConversation).toHaveBeenCalledWith("conversation-direct");
    expect(await screen.findByText("已敲了敲 周远")).toBeTruthy();
  });

  it("接收 Electron 剪贴板事件并在确认目标后复用标准发送链路", async () => {
    const user = userEvent.setup();
    let relayListener: ((payload: DesktopClipboardRelayPayload) => void) | null = null;
    Object.defineProperty(window, "nearChatDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        openServerSettings: vi.fn(),
        requestNotificationPermission: vi.fn(),
        showNotification: vi.fn(),
        getClipboardRelayStatus: vi.fn().mockResolvedValue({
          registered: true,
          accelerator: "CommandOrControl+Shift+V",
          message: "快捷键可用：⌘⇧V",
        }),
        requestClipboardRelay: vi.fn(),
        onClipboardRelay: (listener: (payload: DesktopClipboardRelayPayload) => void) => {
          relayListener = listener;
          return vi.fn();
        },
        onNotificationClick: vi.fn().mockReturnValue(vi.fn()),
      },
    });
    vi.spyOn(api, "directConversation").mockResolvedValue({
      conversationId: "conversation-direct",
    });
    const sendMessage = vi
      .spyOn(api, "sendMessage")
      .mockImplementation(async (conversationId, input) => ({
        message: {
          ...message(conversationId, input.text ?? ""),
          id: "message-clipboard-relay",
          clientMessageId: input.clientMessageId,
        },
      }));

    render(
      <ChatPage
        user={currentUser}
        theme="light"
        onThemeChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await screen.findByText("conversation-one 的最新消息");

    act(() => {
      relayListener?.({
        id: "relay-one",
        text: "桌面剪贴板接力",
        imageDataUrl: null,
        imageSizeBytes: null,
        capturedAt: "2026-08-13T12:00:00.000Z",
        issue: null,
      });
    });
    await user.click(await screen.findByRole("button", { name: "确认发送" }));

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        "conversation-direct",
        expect.objectContaining({ text: "桌面剪贴板接力" }),
      ),
    );
    expect(screen.queryByRole("dialog", { name: "发送剪贴板内容" })).toBeNull();
  });
});
