import { ArrowRight, Hand, X } from "lucide-react";
import type { NudgeEvent } from "../types";
import { Avatar } from "./Avatar";

interface NudgeNoticeProps {
  nudge: NudgeEvent;
  currentConversationId: string | null;
  onOpen: (conversationId: string) => void;
  onDismiss: () => void;
}

/** 接收方的短暂轻提醒；不阻塞当前操作，也不会写入消息历史。 */
export function NudgeNotice({ nudge, currentConversationId, onOpen, onDismiss }: NudgeNoticeProps) {
  const isCurrentConversation = nudge.conversationId === currentConversationId;

  return (
    <aside className="nudge-notice" role="status" aria-live="assertive">
      <span className="nudge-avatar">
        <i />
        <i />
        <Avatar
          name={nudge.senderName}
          color={nudge.senderAvatarColor}
          src={nudge.senderAvatarUrl}
          size="small"
        />
        <span className="nudge-hand" aria-hidden="true">
          <Hand size={12} />
        </span>
      </span>
      <span className="nudge-copy">
        <strong>{nudge.senderName} 敲了敲你</strong>
        <small>{isCurrentConversation ? "就在当前会话" : "来自另一段对话"}</small>
      </span>
      {!isCurrentConversation && (
        <button className="nudge-open" type="button" onClick={() => onOpen(nudge.conversationId)}>
          打开
          <ArrowRight size={13} />
        </button>
      )}
      <button className="nudge-dismiss" type="button" onClick={onDismiss} aria-label="关闭提醒">
        <X size={14} />
      </button>
    </aside>
  );
}
