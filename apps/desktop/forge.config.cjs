module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.nearchat.desktop",
    executableName: "NearChat",
    extendInfo: {
      NSMicrophoneUsageDescription: "近聊仅在你主动录制语音明信片时访问麦克风。",
    },
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
