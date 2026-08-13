import { TimerOff, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { formatFlashRoomRemaining } from "../utils/flash-room";

interface FlashRoomBadgeProps {
  expiresAt: string | null | undefined;
  compact?: boolean;
}

/** 闪聊倒计时独立刷新；到期后从倒计时自然切换为只读标记。 */
export function FlashRoomBadge({ expiresAt, compact = false }: FlashRoomBadgeProps) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const state = formatFlashRoomRemaining(expiresAt, now);
  return (
    <span
      className={`flash-room-badge ${compact ? "is-compact" : ""} ${state.expired ? "is-expired" : ""}`.trim()}
      title={state.expired ? "闪聊已结束，只能查看历史消息" : `闪聊剩余 ${state.label}`}
    >
      {state.expired ? <TimerOff size={compact ? 10 : 12} /> : <Zap size={compact ? 10 : 12} />}
      <strong>
        {state.expired ? "闪聊已结束" : compact ? state.label : `闪聊 · ${state.label}`}
      </strong>
    </span>
  );
}
