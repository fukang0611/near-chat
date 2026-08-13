import { describe, expect, it } from "vitest";
import { canGrantDesktopPermission } from "./permission-policy";

const configuredServerUrl = "http://192.168.10.8:3000";

describe("desktop permission policy", () => {
  it("只为当前近聊源站开放通知权限", () => {
    expect(
      canGrantDesktopPermission({
        permission: "notifications",
        requestingUrl: `${configuredServerUrl}/chat`,
        configuredServerUrl,
      }),
    ).toBe(true);
    expect(
      canGrantDesktopPermission({
        permission: "notifications",
        requestingUrl: "https://outside.example.com",
        configuredServerUrl,
      }),
    ).toBe(false);
  });

  it("仅允许当前源站申请纯音频媒体权限", () => {
    expect(
      canGrantDesktopPermission({
        permission: "media",
        requestingUrl: configuredServerUrl,
        configuredServerUrl,
        mediaTypes: ["audio"],
      }),
    ).toBe(true);
    expect(
      canGrantDesktopPermission({
        permission: "media",
        requestingUrl: configuredServerUrl,
        configuredServerUrl,
        mediaTypes: ["audio", "video"],
      }),
    ).toBe(false);
    expect(
      canGrantDesktopPermission({
        permission: "media",
        requestingUrl: configuredServerUrl,
        configuredServerUrl,
      }),
    ).toBe(false);
  });

  it("拒绝未配置、来源无效与无关权限", () => {
    expect(
      canGrantDesktopPermission({
        permission: "media",
        requestingUrl: configuredServerUrl,
        configuredServerUrl: null,
        mediaTypes: ["audio"],
      }),
    ).toBe(false);
    expect(
      canGrantDesktopPermission({
        permission: "geolocation",
        requestingUrl: configuredServerUrl,
        configuredServerUrl,
      }),
    ).toBe(false);
  });
});
