import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationCapability,
  markNotificationPromptHandled,
  requestNotificationPermission,
  shouldShowNotificationPrompt,
} from "./notifications";

const originalNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, "nearChatDesktop");
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

describe("notification permissions", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    Object.defineProperty(window, "nearChatDesktop", { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, descriptor] of [
      ["Notification", originalNotification],
      ["isSecureContext", originalSecureContext],
      ["nearChatDesktop", originalDesktopBridge],
      ["localStorage", originalLocalStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else delete (window as unknown as Record<string, unknown>)[key];
    }
  });

  it("识别局域网 HTTP 页面无法申请浏览器通知", async () => {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: vi.fn() },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    expect(getNotificationCapability()).toBe("insecure");
    await expect(requestNotificationPermission()).resolves.toMatchObject({
      granted: false,
      status: "insecure",
    });
  });

  it("在用户触发后调用浏览器原生授权", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    await expect(requestNotificationPermission()).resolves.toMatchObject({
      granted: true,
      status: "granted",
    });
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("Electron 环境通过预加载桥接请求本机权限", async () => {
    const bridgeRequest = vi.fn().mockResolvedValue({
      granted: true,
      status: "requested",
      message: "已向系统请求通知权限",
    });
    Object.defineProperty(window, "nearChatDesktop", {
      configurable: true,
      value: { requestNotificationPermission: bridgeRequest },
    });

    expect(getNotificationCapability()).toBe("desktop");
    await expect(requestNotificationPermission()).resolves.toMatchObject({ granted: true });
    expect(bridgeRequest).toHaveBeenCalledOnce();
  });

  it("每个用户只自动提示一次", () => {
    expect(shouldShowNotificationPrompt("user-one")).toBe(true);
    markNotificationPromptHandled("user-one");
    expect(shouldShowNotificationPrompt("user-one")).toBe(false);
    expect(shouldShowNotificationPrompt("user-two")).toBe(true);
  });
});
