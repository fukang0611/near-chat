import { describe, expect, it } from "vitest";
import { notificationFailureMessage } from "./notification-support";

describe("desktop notification failure message", () => {
  it("解释 macOS 中英文 NotificationsNotAllowed 错误", () => {
    const expected =
      "macOS 未允许当前客户端发送通知。请在“系统设置 → 通知 → Electron/近聊”中开启后重试；开发模式请通过 desktop:start 启动。";
    expect(
      notificationFailureMessage("The operation couldn’t be completed. (UNErrorDomain error 1.)"),
    ).toBe(expected);
    expect(notificationFailureMessage("UNErrorDomain Code=1")).toBe(expected);
    expect(notificationFailureMessage("未能完成操作。（UNErrorDomain错误1。）")).toBe(expected);
  });

  it("保留其他具体错误，并为无详情失败提供兜底", () => {
    expect(notificationFailureMessage("notification daemon unavailable")).toBe(
      "notification daemon unavailable",
    );
    expect(notificationFailureMessage(undefined)).toBe("系统未能显示通知，请检查系统通知设置");
  });
});
