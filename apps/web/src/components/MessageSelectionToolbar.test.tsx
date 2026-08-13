import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageSelectionToolbar } from "./MessageSelectionToolbar";

describe("MessageSelectionToolbar", () => {
  it("显示选择数量并触发全选、转发和退出", async () => {
    const onSelectAll = vi.fn();
    const onForward = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageSelectionToolbar
        selectedCount={2}
        selectableCount={6}
        maxSelection={20}
        onSelectAll={onSelectAll}
        onForward={onForward}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("已选择 2 条消息")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "全选当前" }));
    await user.click(screen.getByRole("button", { name: "转发" }));
    await user.click(screen.getByRole("button", { name: "退出多选" }));

    expect(onSelectAll).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
