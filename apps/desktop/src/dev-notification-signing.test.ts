import { describe, expect, it } from "vitest";
import { developmentNotificationSigningCommand } from "./dev-notification-signing";

describe("macOS development notification signing", () => {
  it("为 macOS Electron 运行时生成无证书的本机签名命令", () => {
    expect(
      developmentNotificationSigningCommand(
        "darwin",
        "/project/Electron.app/Contents/MacOS/Electron",
      ),
    ).toEqual({
      file: "/usr/bin/codesign",
      args: [
        "--deep",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "/project/Electron.app/Contents/MacOS/Electron",
      ],
    });
  });

  it("其他平台不执行 macOS 签名", () => {
    expect(developmentNotificationSigningCommand("win32", "electron.exe")).toBeNull();
    expect(developmentNotificationSigningCommand("linux", "electron")).toBeNull();
  });
});
