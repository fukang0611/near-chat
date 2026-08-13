import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

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

  it("把表情插入当前光标位置并恢复输入焦点", async () => {
    const onTextChange = vi.fn();
    const { user } = renderComposer({
      text: "你好世界",
      replyingTo: null,
      onTextChange,
    });
    const textarea = screen.getByPlaceholderText("发消息给 林小满") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    await user.click(screen.getByRole("button", { name: "选择表情" }));
    await user.click(screen.getByRole("button", { name: "开心" }));

    expect(onTextChange).toHaveBeenCalledWith("你好😀世界");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.selectionStart).toBe(4);
    expect(screen.getByRole("dialog", { name: "选择表情" })).toBeTruthy();
  });

  it("点击编辑器外部会关闭表情面板", async () => {
    const { user } = renderComposer({ replyingTo: null });

    await user.click(screen.getByRole("button", { name: "选择表情" }));
    expect(screen.getByRole("dialog", { name: "选择表情" })).toBeTruthy();

    await user.click(document.body);
    expect(screen.queryByRole("dialog", { name: "选择表情" })).toBeNull();
  });

  it("剩余字数不足时不会截断双字节表情", async () => {
    const onTextChange = vi.fn();
    const text = "a".repeat(4_999);
    const { user } = renderComposer({ text, replyingTo: null, onTextChange });
    const textarea = screen.getByPlaceholderText("发消息给 林小满") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(text.length, text.length);

    await user.click(screen.getByRole("button", { name: "选择表情" }));
    await user.click(screen.getByRole("button", { name: "开心" }));

    expect(onTextChange).not.toHaveBeenCalled();
  });
});
