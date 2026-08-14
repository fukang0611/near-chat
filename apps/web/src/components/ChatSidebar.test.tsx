import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../types";
import { ChatSidebar } from "./ChatSidebar";

const currentUser: User = {
  id: "user-admin",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6f63ee",
  avatarUrl: null,
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

const peer: User = {
  id: "peer-user",
  username: "zhouyuan",
  displayName: "周远",
  avatarColor: "#2fae91",
  avatarUrl: null,
  online: true,
  role: "USER",
};

function renderSidebar(overrides: Partial<ComponentProps<typeof ChatSidebar>> = {}) {
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
      contactDelivery={null}
      contactDropBusy={false}
      onThemeChange={vi.fn()}
      onModeChange={vi.fn()}
      onSelectConversation={vi.fn()}
      onOpenDirect={vi.fn()}
      onDropToContact={vi.fn()}
      onCreateGroup={vi.fn()}
      onOpenMessageAssets={vi.fn()}
      onOpenTeamRadar={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenAdmin={vi.fn()}
      onLogout={vi.fn()}
      {...overrides}
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

  it("全局雷达入口可直接打开今日团队概览", async () => {
    const onOpenTeamRadar = vi.fn();
    renderSidebar({ onOpenTeamRadar });

    await userEvent.click(screen.getByRole("button", { name: "打开今日团队雷达" }));

    expect(onOpenTeamRadar).toHaveBeenCalledOnce();
  });

  it("顶部资产入口可直接打开聊天文件管理", async () => {
    const onOpenMessageAssets = vi.fn();
    renderSidebar({ onOpenMessageAssets });

    await userEvent.click(screen.getByRole("button", { name: "打开消息资产" }));

    expect(onOpenMessageAssets).toHaveBeenCalledOnce();
  });

  it("AI 知识库启用后才显示原生入口", async () => {
    const onOpenKnowledge = vi.fn();
    const { rerender } = render(
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
        contactDelivery={null}
        contactDropBusy={false}
        onThemeChange={vi.fn()}
        onModeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onOpenDirect={vi.fn()}
        onDropToContact={vi.fn()}
        onCreateGroup={vi.fn()}
        onOpenMessageAssets={vi.fn()}
        onOpenTeamRadar={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenAdmin={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "打开我的知识库" })).toBeNull();

    rerender(
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
        contactDelivery={null}
        contactDropBusy={false}
        onThemeChange={vi.fn()}
        onModeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onOpenDirect={vi.fn()}
        onDropToContact={vi.fn()}
        onCreateGroup={vi.fn()}
        onOpenMessageAssets={vi.fn()}
        aiAvailable
        onOpenKnowledge={onOpenKnowledge}
        onOpenTeamRadar={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenAdmin={vi.fn()}
        onLogout={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开我的知识库" }));
    expect(onOpenKnowledge).toHaveBeenCalledOnce();
  });

  it("个人助理能力就绪后显示独立入口", async () => {
    const onOpenAssistants = vi.fn();
    renderSidebar({ assistantAvailable: true, onOpenAssistants });

    await userEvent.click(screen.getByRole("button", { name: "打开智能助理" }));

    expect(onOpenAssistants).toHaveBeenCalledOnce();
  });

  it("拖入文本时即时标记联系人，松开后交给聊天页投递", () => {
    const onDropToContact = vi.fn();
    renderSidebar({
      users: [peer],
      mode: "people",
      onDropToContact,
    });
    const target = screen.getByRole("button", { name: /周远/ });
    const dataTransfer = {
      types: ["text/plain"],
      files: [],
      dropEffect: "none",
      getData: () => "  请看最新方案  ",
    } as unknown as DataTransfer;

    fireEvent.dragEnter(target, { dataTransfer });
    expect(screen.getByText("松开发送给 周远")).toBeTruthy();

    fireEvent.drop(target, { dataTransfer });
    expect(onDropToContact).toHaveBeenCalledWith("peer-user", {
      kind: "text",
      text: "请看最新方案",
    });
    expect(screen.queryByText("松开发送给 周远")).toBeNull();
  });

  it("文件优先于拖拽附带的文本地址", () => {
    const onDropToContact = vi.fn();
    const file = new File(["content"], "方案.md", { type: "text/markdown" });
    renderSidebar({ users: [peer], mode: "people", onDropToContact });
    const target = screen.getByRole("button", { name: /周远/ });
    const dataTransfer = {
      types: ["Files", "text/plain"],
      files: [file],
      dropEffect: "none",
      getData: () => "file:///方案.md",
    } as unknown as DataTransfer;

    fireEvent.drop(target, { dataTransfer });
    expect(onDropToContact).toHaveBeenCalledWith("peer-user", {
      kind: "files",
      files: [file],
    });
  });
});
