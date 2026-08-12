import { Fragment, type RefObject } from "react";
import type { Conversation, Message } from "../types";
import { formatClock, formatMessageDay, isSameCalendarDay } from "../utils/format";
import { AttachmentView } from "./AttachmentView";
import { Avatar } from "./Avatar";
import { Check, CheckCheck, LoaderCircle, MessageCircleMore } from "lucide-react";

interface MessageTimelineProps {
  conversation: Conversation;
  messages: Message[];
  currentUserId: string;
  loading: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  highlightedMessageId?: string | null;
}

function receiptText(message: Message): { label: string; read: boolean; delivered: boolean } {
  const { recipientCount, deliveredCount, readCount } = message.receipt;
  if (recipientCount > 0 && readCount === recipientCount) {
    return { label: "已读", read: true, delivered: true };
  }
  if (readCount > 0) {
    return { label: `已读 ${readCount}/${recipientCount}`, read: true, delivered: true };
  }
  if (recipientCount > 0 && deliveredCount === recipientCount) {
    return { label: "已送达", read: false, delivered: true };
  }
  if (deliveredCount > 0) {
    return { label: `已送达 ${deliveredCount}/${recipientCount}`, read: false, delivered: true };
  }
  return { label: "已发送", read: false, delivered: false };
}

function MessageBubble({
  message,
  mine,
  highlighted,
}: {
  message: Message;
  mine: boolean;
  highlighted: boolean;
}) {
  const hasAttachment = message.attachments.length > 0;
  const hasText = Boolean(message.textContent);
  const receipt = mine ? receiptText(message) : null;

  return (
    <div
      id={`message-${message.id}`}
      className={`message-row ${mine ? "is-mine" : "is-peer"} ${hasAttachment ? "has-attachment" : ""} ${hasText ? "has-text" : ""} ${highlighted ? "message-highlight" : ""}`}
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
        <span className="message-meta">
          <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
          {receipt && (
            <span
              className={`message-receipt ${receipt.read ? "is-read" : receipt.delivered ? "is-delivered" : ""}`}
              title={receipt.label}
            >
              {receipt.delivered ? <CheckCheck size={13} /> : <Check size={13} />}
              {receipt.label}
            </span>
          )}
        </span>
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
  highlightedMessageId,
}: MessageTimelineProps) {
  return (
    <div className="message-canvas">
      <div className="conversation-intro">
        <Avatar name={conversation.title} color={conversation.avatarColor} size="large" />
        <strong>{conversation.title}</strong>
        <span>
          {conversation.type === "GROUP"
            ? `${conversation.memberCount} 位成员 · 局域网群聊`
            : `@${conversation.peer?.username ?? "unknown"} · 你们的局域网私聊`}
        </span>
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
            <MessageBubble
              message={message}
              mine={message.senderId === currentUserId}
              highlighted={highlightedMessageId === message.id}
            />
          </Fragment>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
