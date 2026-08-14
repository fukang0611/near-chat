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
    favoriteMessageIds: new Set(),
    favoriteBusyMessageIds: new Set(),
    selectionMode: false,
    selectedMessageIds: new Set(),
    aiActionsAvailable: false,
    onLoadOlder: vi.fn(),
    onReply: vi.fn(),
    onAnnotateImage: vi.fn(),
    onCopy: vi.fn(),
    onToggleFavorite: vi.fn(),
    onBeginSelection: vi.fn(),
    onToggleSelection: vi.fn(),
    onReact: vi.fn().mockResolvedValue(true),
    onRecall: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
    onJumpToMessage: vi.fn(),
    onAiAction: vi.fn(),
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

  it("消息可从纯图标操作栏收藏并展示选中状态", async () => {
    const favorite = message({ id: "45a5a477-83fd-4ad0-bccd-2c4244502c53" });
    const rendered = renderTimeline([favorite]);
    const props = {
      ...rendered.props,
      favoriteMessageIds: new Set([favorite.id]),
    };
    rendered.rerender(<MessageTimeline {...props} />);

    const button = screen.getByRole("button", { name: "取消收藏" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await rendered.user.click(button);

    expect(props.onToggleFavorite).toHaveBeenCalledWith(favorite);
  });

  it("AI 可用时从悬浮操作栏打开快捷处理", async () => {
    const target = message({ id: "2e1b629f-8537-430a-b3f8-eafacaf18413" });
    const rendered = renderTimeline([target]);
    const props = { ...rendered.props, aiActionsAvailable: true };
    rendered.rerender(<MessageTimeline {...props} />);

    await rendered.user.click(screen.getByRole("button", { name: "AI 快捷处理" }));
    expect(props.onAiAction).toHaveBeenCalledWith(target);
  });

  it("纯图片消息不显示必然失败的 AI 入口", () => {
    const target = message({
      type: "IMAGE",
      textContent: null,
      attachments: [
        {
          id: "9c4445b9-7bcf-47b1-bfee-7985beb429a6",
          originalName: "界面.png",
          contentType: "image/png",
          sizeBytes: 1024,
        },
      ],
    });
    const rendered = renderTimeline([target]);
    rendered.rerender(<MessageTimeline {...rendered.props} aiActionsAvailable />);

    expect(screen.queryByRole("button", { name: "AI 快捷处理" })).toBeNull();
  });

  it("从操作栏进入多选后点击消息区域可切换选择", async () => {
    const target = message({ id: "7278b0e5-4a5b-4922-9938-45fffdde42d0" });
    const rendered = renderTimeline([target]);

    await rendered.user.click(screen.getByRole("button", { name: "多选消息" }));
    expect(rendered.props.onBeginSelection).toHaveBeenCalledWith(target);

    const selectedProps = {
      ...rendered.props,
      selectionMode: true,
      selectedMessageIds: new Set([target.id]),
    };
    rendered.rerender(<MessageTimeline {...selectedProps} />);
    expect(screen.getByRole("button", { name: "取消选择此消息" })).toBeTruthy();

    await rendered.user.click(screen.getByText("一条普通消息"));
    expect(rendered.props.onToggleSelection).toHaveBeenCalledWith(target);
  });

  it("可从操作栏添加反应，也可点击聚合标签移除自己的反应", async () => {
    const reacted = message({
      reactions: [
        {
          emoji: "🎉",
          count: 2,
          users: [
            { id: currentUserId, displayName: "当前用户" },
            { id: conversation.peer!.id, displayName: "林小满" },
          ],
        },
      ],
    });
    const { props, user, container } = renderTimeline([reacted]);

    await user.click(screen.getByRole("button", { name: "添加表情反应" }));
    await user.click(screen.getByRole("menuitem", { name: "用喜欢回应" }));
    expect(props.onReact).toHaveBeenCalledWith(reacted, "❤️");
    expect(container.querySelector(".message-reaction-burst")?.textContent).toBe("❤️");

    await user.click(screen.getByRole("button", { name: /移除庆祝反应/ }));
    expect(props.onReact).toHaveBeenLastCalledWith(reacted, "🎉");
    expect(screen.getByRole("button", { name: /当前 2 人/ }).getAttribute("title")).toContain(
      "当前用户、林小满",
    );
  });
});
