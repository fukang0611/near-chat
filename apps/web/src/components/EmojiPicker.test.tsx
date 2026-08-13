import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker";

function mockLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

describe("EmojiPicker", () => {
  beforeEach(mockLocalStorage);

  it("首次打开显示常用表情并允许连续选择", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={onSelect} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "开心" }));
    await user.click(screen.getByRole("button", { name: "大笑" }));

    expect(onSelect).toHaveBeenNthCalledWith(1, "😀");
    expect(onSelect).toHaveBeenNthCalledWith(2, "😃");
    expect(screen.getByRole("dialog", { name: "选择表情" })).toBeTruthy();
  });

  it("搜索无结果时给出提示，Escape 可以关闭", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} onClose={onClose} />);

    await user.type(screen.getByRole("textbox", { name: "搜索表情" }), "不存在的表情");
    expect(screen.getByText("没有找到匹配的表情")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
