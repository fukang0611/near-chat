export type AiAssistantScheduleType = "ONCE" | "DAILY" | "WEEKLY";

const SCHEDULE_INTERVAL_MS: Record<Exclude<AiAssistantScheduleType, "ONCE">, number> = {
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
};

/**
 * 返回一次计划执行完成后的下一次时间。周期任务跳过停机期间错过的时刻，避免
 * 服务恢复时集中补跑；当前 MVP 使用固定 24 小时/7 天间隔，语义简单且可预测。
 */
export function nextAssistantTaskRun(
  scheduleType: AiAssistantScheduleType,
  scheduledFor: Date,
  now = new Date(),
): Date | null {
  if (scheduleType === "ONCE") return null;
  const interval = SCHEDULE_INTERVAL_MS[scheduleType];
  const elapsed = Math.max(0, now.getTime() - scheduledFor.getTime());
  const intervals = Math.floor(elapsed / interval) + 1;
  return new Date(scheduledFor.getTime() + intervals * interval);
}
