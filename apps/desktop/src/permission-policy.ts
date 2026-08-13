export type DesktopMediaType = "audio" | "video" | "unknown";

interface DesktopPermissionRequest {
  permission: string;
  requestingUrl: string;
  configuredServerUrl: string | null;
  mediaTypes?: readonly DesktopMediaType[];
}

/**
 * Electron 权限只向当前配置的近聊源站开放。麦克风请求必须明确为纯音频，
 * 防止未来页面能力扩展时顺带获得摄像头等无关权限。
 */
export function canGrantDesktopPermission({
  permission,
  requestingUrl,
  configuredServerUrl,
  mediaTypes,
}: DesktopPermissionRequest): boolean {
  if (!configuredServerUrl) return false;

  try {
    if (new URL(requestingUrl).origin !== new URL(configuredServerUrl).origin) return false;
  } catch {
    return false;
  }

  if (permission === "notifications") return true;
  if (permission !== "media" || !mediaTypes?.length) return false;

  return mediaTypes.every((mediaType) => mediaType === "audio");
}
