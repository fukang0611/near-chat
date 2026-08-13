import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { MessageComposer } from "./MessageComposer";

const defaultViewport = { width: window.innerWidth, height: window.innerHeight };

const replyTarget: Message = {
  id: "cf09370d-09f3-4d82-8960-0488023f9f2d",
  conversationId: "d6d7973a-b03f-470c-8ab4-6196a2dbde50",
  senderId: "e30fbfff-5e32-49af-bb9e-582c7c51a1d0",
  senderName: "林小满",
  senderAvatarColor: "#E76F88",
  senderAvatarUrl: null,
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

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: defaultViewport.width,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: defaultViewport.height,
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

  it("闪聊到期后保留内容但锁定全部发送入口", async () => {
    const onSend = vi.fn();
    renderComposer({ replyingTo: null, disabled: true, onSend });

    expect(screen.getByText("闪聊已经结束")).toBeTruthy();
    expect((screen.getByPlaceholderText("发消息给 林小满") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "添加图片或附件" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "选择表情" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onSend).not.toHaveBeenCalled();
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

  it("按完整输入器边界把表情面板定位到输入内容上方", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("composer")) return new DOMRect(371, 566, 873, 122);
      if (this.classList.contains("emoji-picker-anchor")) return new DOMRect(433, 637, 36, 36);
      return new DOMRect();
    });
    const { user } = renderComposer({ replyingTo: null });

    await user.click(screen.getByRole("button", { name: "选择表情" }));

    const anchor = screen.getByRole("button", { name: "选择表情" }).parentElement;
    expect(anchor?.style.getPropertyValue("--emoji-picker-offset")).toBe("117px");
    expect(anchor?.style.getPropertyValue("--emoji-picker-viewport-bottom")).toBe("164px");
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
