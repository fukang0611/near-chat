import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import { canProcessMessageWithAi, supportsMessageAiAttachment } from "./message-ai";

const baseMessage: Message = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  senderId: "33333333-3333-4333-8333-333333333333",
  senderName: "测试用户",
  senderAvatarColor: "#6757E8",
  senderAvatarUrl: null,
  clientMessageId: "44444444-4444-4444-8444-444444444444",
  type: "FILE",
  textContent: null,
  createdAt: "2026-08-14T10:00:00.000Z",
  recalledAt: null,
  recallableUntil: "2026-08-14T10:02:00.000Z",
  replyTo: null,
  attachments: [],
  reactions: [],
  receipt: { recipientCount: 1, deliveredCount: 1, readCount: 0 },
};

describe("message AI source detection", () => {
  it("accepts message text and supported documents", () => {
    expect(canProcessMessageWithAi({ ...baseMessage, textContent: "图片说明" })).toBe(true);
    expect(
      supportsMessageAiAttachment({
        id: "55555555-5555-4555-8555-555555555555",
        originalName: "发布计划.md",
        contentType: "application/octet-stream",
        sizeBytes: 120,
      }),
    ).toBe(true);
  });

  it("rejects a pure image until a vision model input is available", () => {
    expect(
      canProcessMessageWithAi({
        ...baseMessage,
        type: "IMAGE",
        attachments: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            originalName: "界面.png",
            contentType: "image/png",
            sizeBytes: 256,
          },
        ],
      }),
    ).toBe(false);
  });
});
