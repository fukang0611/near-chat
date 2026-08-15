import { execFileSync } from "node:child_process";

export interface NotificationSigningCommand {
  file: string;
  args: string[];
}

/**
 * Electron 42+ 的 macOS 通知基于 UNNotification API，开发运行时也必须拥有代码签名。
 * 这里只对当前项目下载的 Electron 可执行文件做 ad-hoc 签名，不读取开发者证书。
 */
export function developmentNotificationSigningCommand(
  platform: NodeJS.Platform,
  electronExecutable: string,
): NotificationSigningCommand | null {
  if (platform !== "darwin") return null;
  return {
    file: "/usr/bin/codesign",
    args: ["--deep", "--force", "--sign", "-", "--timestamp=none", electronExecutable],
  };
}

export function prepareDevelopmentNotifications(
  platform: NodeJS.Platform = process.platform,
  electronExecutable: string = require("electron") as string,
): boolean {
  const command = developmentNotificationSigningCommand(platform, electronExecutable);
  if (!command) return false;
  try {
    execFileSync(command.file, command.args, { stdio: "ignore" });
    console.log(
      "NearChat prepared the signed macOS Electron runtime for development notifications",
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法为 Electron 开发运行时准备 macOS 通知签名：${detail}`);
  }
}

if (require.main === module) prepareDevelopmentNotifications();
