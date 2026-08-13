import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserStatusBubble } from "./UserStatusBubble";

describe("UserStatusBubble", () => {
  afterEach(() => vi.useRealTimers());

  it("显示剩余时间并在过期后自动消失", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T02:00:00.000Z"));
    render(
      <UserStatusBubble
        status={{ text: "专注中", emoji: "🎯", expiresAt: "2026-08-13T02:00:10.000Z" }}
      />,
    );
    expect(screen.getByText("专注中")).toBeTruthy();
    expect(screen.getByText("1 分钟")).toBeTruthy();

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByText("专注中")).toBeNull();
  });
});
