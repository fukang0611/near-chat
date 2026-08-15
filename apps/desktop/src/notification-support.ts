const MACOS_NOTIFICATIONS_NOT_ALLOWED =
  /UNErrorDomain(?:\s+Code\s*=\s*1\b|\s*(?:error|错误)\s*1\b)/i;

/** 将 macOS 原生错误转成用户能直接处理的说明，同时保留其他平台的具体错误。 */
export function notificationFailureMessage(error: string | undefined): string {
  const detail = error?.trim() ?? "";
  if (MACOS_NOTIFICATIONS_NOT_ALLOWED.test(detail)) {
    return "macOS 未允许当前客户端发送通知。请在“系统设置 → 通知 → Electron/近聊”中开启后重试；开发模式请通过 desktop:start 启动。";
  }
  return detail || "系统未能显示通知，请检查系统通知设置";
}
