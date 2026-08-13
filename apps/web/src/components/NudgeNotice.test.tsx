import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NudgeEvent } from "../types";
import { NudgeNotice } from "./NudgeNotice";

const nudge: NudgeEvent = {
  id: "nudge-one",
  conversationId: "conversation-one",
  senderId: "user-one",
  senderName: "林小满",
  senderAvatarColor: "#e46a87",
  senderAvatarUrl: null,
  createdAt: "2026-08-13T10:00:00.000Z",
};

describe("NudgeNotice", () => {
  it("可从另一段对话的提醒直接打开对应会话", async () => {
    const onOpen = vi.fn();
    render(
      <NudgeNotice
        nudge={nudge}
        currentConversationId="conversation-two"
        onOpen={onOpen}
        onDismiss={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /打开/ }));
    expect(onOpen).toHaveBeenCalledWith("conversation-one");
  });

  it("当前会话只提示，不重复显示打开按钮", () => {
    render(
      <NudgeNotice
        nudge={nudge}
        currentConversationId="conversation-one"
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("就在当前会话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /打开/ })).toBeNull();
  });
});
