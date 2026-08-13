import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { User } from "../types";
import { ClipboardRelayDialog } from "./ClipboardRelayDialog";

const users: User[] = [
  {
    id: "alice-id",
    username: "alice",
    displayName: "林小满",
    avatarColor: "#e46a87",
    avatarUrl: null,
    online: true,
  },
  {
    id: "bob-id",
    username: "bob",
    displayName: "周远",
    avatarColor: "#2fae91",
    avatarUrl: null,
    online: false,
  },
];

const payload: DesktopClipboardRelayPayload = {
  id: "relay-one",
  text: "剪贴板里的项目进度",
  imageDataUrl: null,
  imageSizeBytes: null,
  capturedAt: "2026-08-13T12:00:00.000Z",
  issue: null,
};

describe("ClipboardRelayDialog", () => {
  it("选择联系人后再确认发送剪贴板文字", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <ClipboardRelayDialog payload={payload} users={users} onSend={onSend} onDismiss={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("option", { name: /周远/ }));
    await userEvent.click(screen.getByRole("button", { name: "确认发送" }));

    expect(onSend).toHaveBeenCalledWith("bob-id", "text");
  });

  it("Escape 关闭尚未发送的接力面板", async () => {
    const onDismiss = vi.fn();
    render(
      <ClipboardRelayDialog
        payload={payload}
        users={users}
        onSend={vi.fn().mockResolvedValue(true)}
        onDismiss={onDismiss}
      />,
    );

    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
