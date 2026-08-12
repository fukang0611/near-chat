import { Fragment, type RefObject } from "react";
import type { Conversation, Message } from "../types";
import { formatClock, formatMessageDay, isSameCalendarDay } from "../utils/format";
import { AttachmentView } from "./AttachmentView";
import { Avatar } from "./Avatar";
import { LoaderCircle, MessageCircleMore } from "lucide-react";

interface MessageTimelineProps {
  conversation: Conversation;
  messages: Message[];
  currentUserId: string;
  loading: boolean;
  endRef: RefObject<HTMLDivElement | null>;
}

function MessageBubble({ message, mine }: { message: Message; mine: boolean }) {
  const hasAttachment = message.attachments.length > 0;
  const hasText = Boolean(message.textContent);

  return (
    <div
      className={`message-row ${mine ? "is-mine" : "is-peer"} ${hasAttachment ? "has-attachment" : ""} ${hasText ? "has-text" : ""}`}
    >
      {!mine && <Avatar name={message.senderName} color={message.senderAvatarColor} size="small" />}
      <div className="message-stack">
        {!mine && <span className="sender-name">{message.senderName}</span>}
        <div className="message-content">
          {message.attachments.map((attachment) => (
            <AttachmentView attachment={attachment} key={attachment.id} />
          ))}
          {message.textContent && (
            <div className={`message-bubble ${mine ? "mine-bubble" : "peer-bubble"}`}>
              {message.textContent}
            </div>
          )}
        </div>
        <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
      </div>
    </div>
  );
}

/** 当前会话的纯展示模块，不负责请求、已读状态或实时连接。 */
export function MessageTimeline({
  conversation,
  messages,
  currentUserId,
  loading,
  endRef,
}: MessageTimelineProps) {
  return (
    <div className="message-canvas">
      <div className="conversation-intro">
        <Avatar
          name={conversation.peer.displayName}
          color={conversation.peer.avatarColor}
          size="large"
        />
        <strong>{conversation.peer.displayName}</strong>
        <span>@{conversation.peer.username} · 你们的局域网私聊</span>
      </div>

      {loading ? (
        <div className="messages-loading">
          <LoaderCircle className="spin" size={21} />
          正在同步消息
        </div>
      ) : messages.length === 0 ? (
        <div className="conversation-empty">
          <MessageCircleMore size={22} />
          <strong>还没有消息</strong>
          <span>从一句简单的问候开始吧</span>
        </div>
      ) : (
        messages.map((message, index) => (
          <Fragment key={message.id}>
            {(index === 0 ||
              !isSameCalendarDay(messages[index - 1].createdAt, message.createdAt)) && (
              <div className="day-separator">
                <span>{formatMessageDay(message.createdAt)}</span>
              </div>
            )}
            <MessageBubble message={message} mine={message.senderId === currentUserId} />
          </Fragment>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
