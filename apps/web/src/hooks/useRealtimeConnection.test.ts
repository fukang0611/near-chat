import { describe, expect, it } from "vitest";
import { parseRealtimeEvent } from "./useRealtimeConnection";

describe("parseRealtimeEvent", () => {
  it("保留消息反应的成员聚合结果", () => {
    const message = {
      id: "message-one",
      conversationId: "conversation-one",
      senderId: "user-one",
      senderName: "林小满",
      senderAvatarColor: "#e46a87",
      senderAvatarUrl: null,
      clientMessageId: "client-one",
      type: "TEXT",
      textContent: "收到",
      createdAt: "2026-08-13T10:00:00.000Z",
      recalledAt: null,
      recallableUntil: "2026-08-13T10:02:00.000Z",
      replyTo: null,
      attachments: [],
      reactions: [
        {
          emoji: "👍",
          count: 1,
          users: [{ id: "user-two", displayName: "周远" }],
        },
      ],
      receipt: { recipientCount: 1, deliveredCount: 1, readCount: 1 },
    };

    expect(
      parseRealtimeEvent(JSON.stringify({ type: "message.updated", payload: { message } })),
    ).toEqual({ type: "message.updated", payload: { message } });
  });

  it("解析完整的敲一下事件", () => {
    const nudge = {
      id: "nudge-one",
      conversationId: "conversation-one",
      senderId: "user-one",
      senderName: "林小满",
      senderAvatarColor: "#e46a87",
      senderAvatarUrl: "/api/avatars/user-one?v=2",
      createdAt: "2026-08-13T10:00:00.000Z",
    };

    expect(parseRealtimeEvent(JSON.stringify({ type: "nudge.received", payload: nudge }))).toEqual({
      type: "nudge.received",
      payload: { nudge },
    });
  });

  it("拒绝字段不完整的敲一下事件", () => {
    expect(
      parseRealtimeEvent(
        JSON.stringify({
          type: "nudge.received",
          payload: { id: "nudge-one", senderName: "林小满" },
        }),
      ),
    ).toBeNull();
  });

  it("解析管理员热切换后的 AI 能力广播", () => {
    const capabilities = {
      enabled: false,
      status: "DISABLED",
      reason: "AI 增强能力未启用",
      features: {
        knowledgeManagement: false,
        knowledgeIndexing: false,
        knowledgeSearch: false,
        knowledgeAnswer: false,
        personalAssistants: false,
        messageActions: false,
      },
      provider: {
        chatModel: null,
        embeddingModel: null,
        embeddingDimensions: 1536,
      },
    };

    expect(
      parseRealtimeEvent(
        JSON.stringify({ type: "ai.capabilities.changed", payload: { capabilities } }),
      ),
    ).toEqual({ type: "ai.capabilities.changed", payload: { capabilities } });
  });

  it("解析助理后台任务完成事件", () => {
    const task = {
      taskId: "task-one",
      assistantId: "assistant-one",
      assistantName: "分析搭档",
      taskTitle: "每日摘要",
      status: "SUCCEEDED",
      messageId: "message-one",
      preview: "今天完成了三项工作。",
      createdAt: "2026-08-14T10:00:00.000Z",
    };

    expect(
      parseRealtimeEvent(JSON.stringify({ type: "assistant.task.completed", payload: task })),
    ).toEqual({ type: "assistant.task.completed", payload: { task } });
  });
});
