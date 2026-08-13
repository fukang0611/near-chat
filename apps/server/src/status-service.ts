export interface PublicUserStatus {
  text: string;
  emoji: string;
  expiresAt: string;
}

/**
 * 将数据库中的限时状态转换为公开资料。已过期或不完整的记录统一视为无状态，
 * 因而不需要依赖后台定时任务才能准时从客户端消失。
 */
export function activeUserStatus(
  text: string | null | undefined,
  emoji: string | null | undefined,
  expiresAt: Date | string | null | undefined,
  now = new Date(),
): PublicUserStatus | null {
  if (!text || !emoji || !expiresAt) return null;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  return { text, emoji, expiresAt: expiry.toISOString() };
}

/** 状态最多保留 24 小时，保持它是轻量的当下信号，而不是第二套个人签名。 */
export function isAllowedStatusExpiry(expiresAt: Date, now = new Date()): boolean {
  const duration = expiresAt.getTime() - now.getTime();
  return duration >= 60_000 && duration <= 24 * 60 * 60 * 1_000;
}
