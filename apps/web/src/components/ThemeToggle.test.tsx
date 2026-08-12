import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("分段控件展示当前主题并允许切换", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle theme="light" onChange={onChange} />);

    expect(screen.getByRole("button", { name: "明亮" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "黑暗" }).getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "黑暗" }));

    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("快捷按钮说明将要切换到的主题", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle compact theme="dark" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "切换到明亮主题" }));

    expect(onChange).toHaveBeenCalledWith("light");
  });
});
