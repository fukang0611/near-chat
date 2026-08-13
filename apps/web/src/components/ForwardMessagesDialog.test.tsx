import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conversation, Message } from "../types";
import { ForwardMessagesDialog } from "./ForwardMessagesDialog";

const target: Conversation = {
  id: "d65ea1f8-ddd0-4c78-a04f-c9f44664c579",
  type: "GROUP",
  title: "交付讨论",
  avatarColor: "#6757e8",
  avatarUrl: null,
  ownerId: "user-admin",
  expiresAt: null,
  peer: null,
  members: [],
  memberCount: 4,
  onlineMemberCount: 2,
  lastMessage: null,
  unreadCount: 0,
};

const message: Message = {
  id: "c44a17f3-44a2-49e9-9a5b-c3cda08a1478",
  conversationId: "source-conversation",
  senderId: "user-alice",
  senderName: "林小满",
  senderAvatarColor: "#e76f88",
  senderAvatarUrl: null,
  clientMessageId: "fbf5db02-c32e-439c-8546-1c34a57a06da",
  type: "TEXT",
  textContent: "请确认最终交付时间",
  createdAt: "2026-08-13T10:30:00.000Z",
  recalledAt: null,
  recallableUntil: "2026-08-13T10:32:00.000Z",
  replyTo: null,
  attachments: [],
  receipt: { recipientCount: 1, deliveredCount: 1, readCount: 0 },
};

describe("ForwardMessagesDialog", () => {
  it("预览所选消息并提交唯一目标会话", async () => {
    const onForward = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ForwardMessagesDialog
        conversations={[target]}
        messages={[message]}
        onClose={onClose}
        onForward={onForward}
      />,
    );

    expect(screen.getByText("请确认最终交付时间")).toBeTruthy();
    await user.click(screen.getByRole("option", { name: /交付讨论/ }));
    await user.click(screen.getByRole("button", { name: "确认转发" }));

    expect(onForward).toHaveBeenCalledWith(target.id);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("已结束的闪聊不能作为转发目标", () => {
    render(
      <ForwardMessagesDialog
        conversations={[{ ...target, expiresAt: "2020-01-01T00:00:00.000Z" }]}
        messages={[message]}
        onClose={vi.fn()}
        onForward={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: /交付讨论/ }).hasAttribute("disabled")).toBe(true);
  });
});
