import { useEffect, useState } from "react";
import type { UserStatus } from "../types";
import { formatStatusRemaining, isActiveUserStatus } from "../utils/user-status";

interface UserStatusBubbleProps {
  status: UserStatus | null | undefined;
  compact?: boolean;
  className?: string;
}

/** 独立计时让状态即使没有新的 WebSocket 事件，也会在过期时准时从界面消失。 */
export function UserStatusBubble({
  status,
  compact = false,
  className = "",
}: UserStatusBubbleProps) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!isActiveUserStatus(status, now)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [now, status]);

  if (!isActiveUserStatus(status, now)) return null;
  return (
    <span
      className={`user-status-bubble ${compact ? "is-compact" : ""} ${className}`.trim()}
      title={`${status.text} · 剩余 ${formatStatusRemaining(status, now)}`}
    >
      <span aria-hidden="true">{status.emoji}</span>
      <strong>{status.text}</strong>
      {!compact && <small>{formatStatusRemaining(status, now)}</small>}
    </span>
  );
}
