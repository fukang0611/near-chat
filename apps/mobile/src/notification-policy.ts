import type { PersonalReminder } from "./models";

export function shouldScheduleReminder(reminder: PersonalReminder, nowMs = Date.now()): boolean {
  if (reminder.completedAt) return false;
  const scheduledAt = Date.parse(reminder.scheduledAt);
  return Number.isFinite(scheduledAt) && scheduledAt > nowMs;
}

export async function replaceReminderSchedule(
  reminder: PersonalReminder,
  effects: {
    cancel(id: string): Promise<void>;
    ensurePermission(): Promise<boolean>;
    canSchedule(): boolean;
    schedule(reminder: PersonalReminder): Promise<void>;
  },
): Promise<boolean> {
  // 稳定 ID 的旧 alarm 必须先撤销；权限被收回时也不能留下旧时间/旧正文。
  await effects.cancel(reminder.id);
  if (!shouldScheduleReminder(reminder)) return false;
  if (!(await effects.ensurePermission()) || !effects.canSchedule()) return false;
  await effects.schedule(reminder);
  return true;
}
