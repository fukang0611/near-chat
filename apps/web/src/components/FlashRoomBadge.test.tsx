import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlashRoomBadge } from "./FlashRoomBadge";

describe("FlashRoomBadge", () => {
  afterEach(() => vi.useRealTimers());

  it("倒计时结束后自动切换为只读标记", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T02:00:00.000Z"));
    render(<FlashRoomBadge expiresAt="2026-08-13T02:00:05.000Z" />);
    expect(screen.getByText("闪聊 · 1 分钟")).toBeTruthy();

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("闪聊已结束")).toBeTruthy();
  });
});
