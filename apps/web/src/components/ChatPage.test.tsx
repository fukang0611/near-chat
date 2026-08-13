import { render, screen, waitFor } from "@testing-library/react";
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
    ];
    vi.spyOn(api, "users").mockResolvedValue({ users: [currentUser] });
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
});
