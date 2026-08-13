export interface NotificationPreferences {
  desktop: boolean;
  sound: boolean;
}

export type NotificationCapability =
  "desktop" | "granted" | "prompt" | "denied" | "insecure" | "unsupported";

export interface NotificationPermissionResult {
  granted: boolean;
  status: "granted" | "requested" | "denied" | "insecure" | "unsupported" | "failed";
  message: string;
}

const defaultPreferences: NotificationPreferences = { desktop: false, sound: false };

function storageKey(userId: string): string {
  return `near-chat-notifications:${userId}`;
}

function promptStorageKey(userId: string): string {
  return `near-chat-notification-prompt:${userId}`;
}

export function loadNotificationPreferences(userId: string): NotificationPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(storageKey(userId)) ?? "null",
    ) as Partial<NotificationPreferences> | null;
    return {
      desktop: stored?.desktop === true,
      sound: stored?.sound === true,
    };
  } catch {
    return defaultPreferences;
  }
}

export function saveNotificationPreferences(
  userId: string,
  preferences: NotificationPreferences,
): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
  } catch {
    // 隐私模式可能禁用持久化，但当前页面仍可继续使用该偏好。
  }
}

/** 返回当前运行环境真正可用的通知链路，Electron 不受局域网 HTTP 限制。 */
export function getNotificationCapability(): NotificationCapability {
  if (window.nearChatDesktop) return "desktop";
  if (!("Notification" in window)) return "unsupported";
  if (window.isSecureContext === false) return "insecure";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return "prompt";
}

/**
 * 原生权限弹窗必须紧跟用户点击执行；浏览器会拒绝页面加载后直接调用。
 * 因此产品先自动展示解释弹窗，再由“开启通知”按钮调用此函数。
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (window.nearChatDesktop) {
    try {
      return await window.nearChatDesktop.requestNotificationPermission();
    } catch {
      return { granted: false, status: "failed", message: "系统通知授权失败，请稍后重试" };
    }
  }

  const capability = getNotificationCapability();
  if (capability === "unsupported") {
    return { granted: false, status: "unsupported", message: "当前浏览器不支持系统通知" };
  }
  if (capability === "insecure") {
    return {
      granted: false,
      status: "insecure",
      message: "浏览器仅允许 HTTPS 页面申请系统通知，请改用 HTTPS 或 Electron 客户端",
    };
  }
  if (capability === "denied") {
    return {
      granted: false,
      status: "denied",
      message: "通知已被浏览器阻止，请在地址栏的站点设置中重新允许",
    };
  }
  if (capability === "granted") {
    return { granted: true, status: "granted", message: "浏览器通知已开启" };
  }

  try {
    const permission = await Notification.requestPermission();
    return permission === "granted"
      ? { granted: true, status: "granted", message: "浏览器通知已开启" }
      : {
          granted: false,
          status: permission === "denied" ? "denied" : "failed",
          message:
            permission === "denied"
              ? "你已拒绝通知，可稍后在浏览器站点设置中重新开启"
              : "浏览器未完成通知授权，请稍后重试",
        };
  } catch {
    return { granted: false, status: "failed", message: "浏览器未能发起通知授权" };
  }
}

export function shouldShowNotificationPrompt(userId: string): boolean {
  try {
    return localStorage.getItem(promptStorageKey(userId)) !== "handled";
  } catch {
    return true;
  }
}

export function markNotificationPromptHandled(userId: string): void {
  try {
    localStorage.setItem(promptStorageKey(userId), "handled");
  } catch {
    // 隐私模式可能禁用持久化；授权流程本身仍可继续。
  }
}

/** 使用 Web Audio 生成极短提示音，无需额外静态资源且离线可用。 */
export async function playMessageSound(): Promise<void> {
  const ExtendedWindow = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = window.AudioContext ?? ExtendedWindow.webkitAudioContext;
  if (!AudioContextConstructor) return;

  const context = new AudioContextConstructor();
  try {
    if (context.state === "suspended") await context.resume();
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(880, context.currentTime + 0.1);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.14);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
  } finally {
    await context.close().catch(() => undefined);
  }
}
