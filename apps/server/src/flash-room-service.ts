/** 闪聊最短 5 分钟、最长 7 天；客户端首期只提供 30 分钟至 24 小时。 */
export function isAllowedFlashRoomExpiry(expiresAt: Date, now = new Date()): boolean {
  const duration = expiresAt.getTime() - now.getTime();
  return duration >= 5 * 60_000 && duration <= 7 * 24 * 60 * 60_000;
}

export function isFlashRoomExpired(expiresAt: Date | string | null, now = new Date()): boolean {
  if (!expiresAt) return false;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= now.getTime();
}
