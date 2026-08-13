import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("使用图片地址显示自定义头像并保留 GIF 资源", () => {
    const { container } = render(
      <Avatar name="林小满" color="#E76F88" src="/api/users/alice/avatar?v=2" />,
    );

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/api/users/alice/avatar?v=2");
    expect(image?.getAttribute("draggable")).toBe("false");
  });

  it("图片读取失败时恢复为文字头像", () => {
    const { container } = render(
      <Avatar name="林小满" color="#E76F88" src="/api/users/alice/avatar?v=2" />,
    );

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".avatar")?.textContent).toContain("林小");
  });
});
