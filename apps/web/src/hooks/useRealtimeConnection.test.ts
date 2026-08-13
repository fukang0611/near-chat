import { describe, expect, it } from "vitest";
import { parseRealtimeEvent } from "./useRealtimeConnection";

describe("parseRealtimeEvent", () => {
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
});
