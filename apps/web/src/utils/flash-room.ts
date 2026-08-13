export function isFlashRoomExpired(
  expiresAt: string | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= now);
}

export function formatFlashRoomRemaining(
  expiresAt: string,
  now = Date.now(),
): { expired: boolean; label: string } {
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { expired: true, label: "已结束" };
  }
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) return { expired: false, label: `${minutes} 分钟` };
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return {
    expired: false,
    label: remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`,
  };
}
