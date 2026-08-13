export interface TeamDayWindow {
  start: Date;
  end: Date;
}

/**
 * 按客户端当前时区计算“今天”的 UTC 边界。getTimezoneOffset 的语义是
 * “本地时间加多少分钟得到 UTC”，因此上海等东区会传入负数。
 */
export function teamDayWindow(timezoneOffsetMinutes: number, now = new Date()): TeamDayWindow {
  const shiftedNow = new Date(now.getTime() - timezoneOffsetMinutes * 60_000);
  const shiftedStart = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
  );
  const start = new Date(shiftedStart + timezoneOffsetMinutes * 60_000);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}
