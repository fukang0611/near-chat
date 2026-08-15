const macSignIdentity = process.env.NEAR_CHAT_MAC_SIGN_IDENTITY?.trim() || "-";
const macSignOptions = {
  identity: macSignIdentity,
  continueOnError: false,
  ...(macSignIdentity === "-"
    ? {
        identityValidation: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
      }
    : {}),
};

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.nearchat.desktop",
    executableName: "NearChat",
    extendInfo: {
      NSMicrophoneUsageDescription: "近聊仅在你主动录制语音明信片时访问麦克风。",
    },
    // Electron 42+ 在 macOS 上改用 UNNotification API，未签名应用无法发送通知。
    // 本地包默认使用 ad-hoc 签名；正式分发时可通过环境变量指定 Developer ID。
    ...(process.platform === "darwin" ? { osxSign: macSignOptions } : {}),
    ignore: [/^\/src(?:\/|$)/, /^\/static(?:\/|$)/, /^\/scripts(?:\/|$)/, /\.test\.[cm]?[jt]s$/],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "near_chat",
        authors: "NearChat",
        description: "近聊局域网聊天桌面客户端",
        setupExe: "NearChatSetup.exe",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
