export interface NotificationPreferences {
  desktop: boolean;
  sound: boolean;
}

const defaultPreferences: NotificationPreferences = { desktop: false, sound: false };

function storageKey(userId: string): string {
  return `near-chat-notifications:${userId}`;
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
  localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
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
