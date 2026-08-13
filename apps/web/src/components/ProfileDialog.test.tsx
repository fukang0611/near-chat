import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { User } from "../types";
import { ProfileDialog } from "./ProfileDialog";

const currentUser: User = {
  id: "user-one",
  username: "alice",
  displayName: "林小满",
  avatarColor: "#E76F88",
  avatarUrl: null,
  role: "USER",
};

describe("ProfileDialog avatar presets", () => {
  beforeEach(() => {
    vi.spyOn(api, "fileQuota").mockResolvedValue({
      usedBytes: 0,
      quotaBytes: 1024,
      remainingBytes: 1024,
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("点击预设后按 GIF 原文件走统一头像上传接口", async () => {
    const updatedUser = { ...currentUser, avatarUrl: "/api/users/user-one/avatar?v=1" };
    const uploadAvatar = vi.spyOn(api, "uploadAvatar").mockResolvedValue({ user: updatedUser });
    const onUpdated = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(["GIF89a"], { type: "image/gif" })),
      }),
    );

    render(
      <ProfileDialog
        user={currentUser}
        onClose={vi.fn()}
        onUpdated={onUpdated}
        onPasswordChanged={vi.fn()}
        notificationPreferences={{ desktop: false, sound: false }}
        onNotificationPreferencesChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "使用动态头像：星星云朵" }));

    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledOnce());
    const uploadedFile = uploadAvatar.mock.calls[0][0];
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.type).toBe("image/gif");
    expect(uploadedFile.name).toBe("blue-cloud.gif");
    expect(onUpdated).toHaveBeenCalledWith(updatedUser);
    expect(await screen.findByText("已应用“星星云朵”动态头像")).toBeTruthy();
  });
});
