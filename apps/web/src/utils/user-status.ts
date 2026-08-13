import type { UserStatus } from "../types";

export function isActiveUserStatus(
  status: UserStatus | null | undefined,
  now = Date.now(),
): status is UserStatus {
  return Boolean(status && new Date(status.expiresAt).getTime() > now);
}

export function formatStatusRemaining(status: UserStatus, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((new Date(status.expiresAt).getTime() - now) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}
