import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { PersonalReminder } from "./models";
import { replaceReminderSchedule } from "./notification-policy";
import { notificationIdFor } from "./sync-logic";

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform())
    return "Notification" in window && Notification.permission === "granted";
  const current = await LocalNotifications.checkPermissions();
  if (current.display === "granted") return true;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === "granted";
}

export async function scheduleReminder(reminder: PersonalReminder): Promise<boolean> {
  return replaceReminderSchedule(reminder, {
    cancel: cancelReminder,
    ensurePermission: ensureNotificationPermission,
    canSchedule: () => Capacitor.isNativePlatform(),
    async schedule(value) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: notificationIdFor(value.id),
            title: value.title,
            body: value.note || "NearChat 提醒时间到了",
            schedule: { at: new Date(value.scheduledAt), allowWhileIdle: true },
            extra: { reminderId: value.id },
          },
        ],
      });
    },
  });
}

export async function cancelReminder(id: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [{ id: notificationIdFor(id) }] });
}

export async function reconcileReminderNotifications(reminders: PersonalReminder[]): Promise<void> {
  for (const reminder of reminders) {
    if (!reminder.completedAt && new Date(reminder.scheduledAt).getTime() > Date.now()) {
      await scheduleReminder(reminder);
    } else {
      await cancelReminder(reminder.id);
    }
  }
}

/** 切换账号或登出前按旧命名空间显式撤销，避免标题/备注跨账号留在系统通知队列。 */
export async function cancelReminderNotifications(reminders: PersonalReminder[]): Promise<void> {
  for (const reminder of reminders) await cancelReminder(reminder.id);
}
