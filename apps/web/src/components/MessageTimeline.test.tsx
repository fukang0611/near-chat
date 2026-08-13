import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "../types";
import { MessageTimeline } from "./MessageTimeline";

const currentUserId = "8cc408ad-2e87-40f9-b10e-aa814a831480";
const conversation: Conversation = {
  id: "29a8482a-dd5e-4e1c-8e30-f266269b7e21",
  type: "DIRECT",
  title: "林小满",
  avatarColor: "#E76F88",
  avatarUrl: null,
  ownerId: null,
  peer: {
    id: "3bb44efa-207f-4b06-a866-cb8fc2923e08",
    username: "alice",
    displayName: "林小满",
    avatarColor: "#E76F88",
    avatarUrl: null,
  },
  members: [],
  memberCount: 2,
  onlineMemberCount: 1,
  lastMessage: null,
  unreadCount: 0,
};

function message(overrides: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    senderId: currentUserId,
    senderName: "当前用户",
    senderAvatarColor: "#6757E8",
    senderAvatarUrl: null,
    clientMessageId: crypto.randomUUID(),
    type: "TEXT",
    textContent: "一条普通消息",
    createdAt: new Date().toISOString(),
    recalledAt: null,
    recallableUntil: new Date(Date.now() + 60_000).toISOString(),
    replyTo: null,
    attachments: [],
    receipt: { recipientCount: 1, deliveredCount: 1, readCount: 0 },
    ...overrides,
  };
}

function renderTimeline(messages: Message[]) {
  const props: React.ComponentProps<typeof MessageTimeline> = {
    conversation,
    messages,
    currentUserId,
    loading: false,
    loadingOlder: false,
    hasMore: false,
    endRef: createRef<HTMLDivElement>(),
    onLoadOlder: vi.fn(),
    onReply: vi.fn(),
    onAnnotateImage: vi.fn(),
    onCopy: vi.fn(),
    onRecall: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
    onJumpToMessage: vi.fn(),
  };
  return { props, user: userEvent.setup(), ...render(<MessageTimeline {...props} />) };
}

describe("MessageTimeline", () => {
  it("失败消息提供使用同一消息重试和删除的入口", async () => {
    const failed = message({ deliveryState: "FAILED", sendError: "网络连接中断" });
    const { props, user } = renderTimeline([failed]);

    expect(screen.getByText("网络连接中断")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(props.onRetry).toHaveBeenCalledWith(failed);
    expect(props.onDiscard).toHaveBeenCalledWith(failed);
  });

  it("引用可定位原消息，发送者可二次确认撤回", async () => {
    const reply = message({
      replyTo: {
        id: "be6dd8bb-0b8b-4979-8d75-385c2232ef8c",
        senderId: conversation.peer!.id,
        senderName: "林小满",
        type: "TEXT",
        textContent: "被引用的内容",
        attachmentName: null,
        recalled: false,
      },
    });
    const { props, user } = renderTimeline([reply]);

    const actionBar = screen.getByLabelText("消息操作");
    expect(actionBar.textContent).toBe("");

    await user.click(screen.getByRole("button", { name: /被引用的内容/ }));
    await user.click(screen.getByRole("button", { name: "撤回" }));
    expect(actionBar.textContent).toBe("");
    await user.click(screen.getByRole("button", { name: "确认撤回" }));

    expect(props.onJumpToMessage).toHaveBeenCalledWith(reply.replyTo!.id);
    expect(props.onRecall).toHaveBeenCalledWith(reply);
  });

  it("撤回消息不再渲染原文本和附件", () => {
    renderTimeline([
      message({
        textContent: null,
        recalledAt: new Date().toISOString(),
        attachments: [],
      }),
    ]);

    expect(screen.getByText("你撤回了一条消息")).toBeTruthy();
    expect(screen.queryByText("一条普通消息")).toBeNull();
  });
});
