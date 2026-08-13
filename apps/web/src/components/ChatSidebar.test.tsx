import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../types";
import { ChatSidebar } from "./ChatSidebar";

const currentUser: User = {
  id: "user-admin",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6f63ee",
  online: true,
  role: "ADMIN",
};

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderSidebar() {
  render(
    <ChatSidebar
      currentUser={currentUser}
      users={[currentUser]}
      conversations={[]}
      selectedId={null}
      drafts={{}}
      pendingAttachments={{}}
      loading={false}
      connection="connected"
      theme="light"
      mode="recent"
      onThemeChange={vi.fn()}
      onModeChange={vi.fn()}
      onSelectConversation={vi.fn()}
      onOpenDirect={vi.fn()}
      onCreateGroup={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenAdmin={vi.fn()}
      onLogout={vi.fn()}
    />,
  );
}

describe("ChatSidebar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("系统菜单靠近左侧时会被限制在侧栏安全区域内", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("sidebar")) return rectangle(9, 9, 326, 780);
      if (this.classList.contains("system-menu-anchor")) return rectangle(166, 24, 36, 36);
      return rectangle(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("system-popover") ? 276 : 0;
    });

    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "查看系统信息" }));

    const anchor = screen.getByRole("dialog", { name: "系统信息" }).parentElement;
    expect(anchor?.style.getPropertyValue("--system-popover-left")).toBe("-145px");
    expect(anchor?.style.getPropertyValue("--system-popover-origin-x")).toBe("163px");
  });

  it("Escape 关闭系统菜单", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "查看系统信息" }));
    expect(screen.getByRole("dialog", { name: "系统信息" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "系统信息" })).toBeNull();
  });
});
