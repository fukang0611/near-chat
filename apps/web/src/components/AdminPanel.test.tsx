import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AdminUser, AiCapabilities } from "../types";
import { AdminPanel } from "./AdminPanel";

const admin: AdminUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6655dd",
  avatarUrl: null,
  role: "ADMIN",
  enabled: true,
  online: true,
};

describe("AdminPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("从管理中心页签进入连接器配置", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "adminUsers").mockResolvedValue({ users: [admin] });
    vi.spyOn(api, "adminConnectors").mockResolvedValue({ connectors: [] });
    vi.spyOn(api, "aiAssistants").mockResolvedValue({ assistants: [] });
    vi.spyOn(api, "conversations").mockResolvedValue({ conversations: [] });

    render(
      <AdminPanel
        currentUser={admin}
        onClose={vi.fn()}
        onNotify={vi.fn()}
        onAiCapabilitiesChanged={vi.fn<(capabilities: AiCapabilities) => void>()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "连接器" }));
    expect(await screen.findByText("外部平台接入")).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建第一个连接器" })).toBeTruthy();
  });
});
