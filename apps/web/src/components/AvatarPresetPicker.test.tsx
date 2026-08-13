import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { avatarPresets } from "../avatar-presets";
import { AvatarPresetPicker } from "./AvatarPresetPicker";

describe("AvatarPresetPicker", () => {
  it("展示 16 个离线 GIF 动态头像", () => {
    render(<AvatarPresetPicker selectingId={null} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(16);
    expect(avatarPresets).toHaveLength(16);
    expect(avatarPresets.every((preset) => preset.src.endsWith(".gif"))).toBe(true);
  });

  it("选择头像时回传对应预设", async () => {
    const onSelect = vi.fn();
    render(<AvatarPresetPicker selectingId={null} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "使用动态头像：薄荷柴犬" }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "teal-shiba", src: "/avatar-presets/teal-shiba.gif" }),
    );
  });
});
