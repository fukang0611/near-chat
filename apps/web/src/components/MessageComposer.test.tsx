import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { MessageComposer } from "./MessageComposer";

const replyTarget: Message = {
  id: "cf09370d-09f3-4d82-8960-0488023f9f2d",
  conversationId: "d6d7973a-b03f-470c-8ab4-6196a2dbde50",
  senderId: "e30fbfff-5e32-49af-bb9e-582c7c51a1d0",
  senderName: "林小满",
  senderAvatarColor: "#E76F88",
  clientMessageId: "ca19022f-1766-4baf-a5e1-c3b28eea5dcc",
  type: "TEXT",
  textContent: "这是需要引用的原消息",
  createdAt: "2026-08-12T09:00:00.000Z",
  recalledAt: null,
  recallableUntil: "2026-08-12T09:02:00.000Z",
  replyTo: null,
  attachments: [],
  receipt: { recipientCount: 1, deliveredCount: 1, readCount: 0 },
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const props: React.ComponentProps<typeof MessageComposer> = {
    peerName: "林小满",
    text: "准备发送",
    pendingAttachment: null,
    upload: null,
    uploadBlocked: false,
    sending: false,
    replyingTo: replyTarget,
    onTextChange: vi.fn(),
    onChooseFile: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSend: vi.fn(),
    onCancelReply: vi.fn(),
    ...overrides,
  };
  return { props, user: userEvent.setup(), ...render(<MessageComposer {...props} />) };
}

describe("MessageComposer", () => {
  it("展示引用摘要并允许取消回复", async () => {
    const { props, user } = renderComposer();

    expect(screen.getByText("回复 林小满")).toBeTruthy();
    expect(screen.getByText("这是需要引用的原消息")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消回复" }));

    expect(props.onCancelReply).toHaveBeenCalledOnce();
  });

  it("在内容有效时提交消息", async () => {
    const onSend = vi.fn();
    const { user } = renderComposer({ replyingTo: null, onSend });

    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSend).toHaveBeenCalledOnce();
  });
});
