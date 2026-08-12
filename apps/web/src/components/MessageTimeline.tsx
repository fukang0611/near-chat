import {
  Check,
  CheckCheck,
  Copy,
  LoaderCircle,
  MessageCircleMore,
  RefreshCw,
  Reply,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, type RefObject, useEffect, useState } from "react";
import type { Conversation, Message } from "../types";
import { formatClock, formatMessageDay, isSameCalendarDay } from "../utils/format";
import { replySummary } from "../utils/message";
import { AttachmentView } from "./AttachmentView";
import { Avatar } from "./Avatar";

interface MessageTimelineProps {
  conversation: Conversation;
  messages: Message[];
  currentUserId: string;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  highlightedMessageId?: string | null;
  onLoadOlder: () => void;
  onReply: (message: Message) => void;
  onCopy: (message: Message) => void;
  onRecall: (message: Message) => void;
  onRetry: (message: Message) => void;
  onDiscard: (message: Message) => void;
  onJumpToMessage: (messageId: string) => void;
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

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  highlighted: boolean;
  now: number;
  confirmRecall: boolean;
  onReply: (message: Message) => void;
  onCopy: (message: Message) => void;
  onRecallIntent: (messageId: string | null) => void;
  onRecall: (message: Message) => void;
  onRetry: (message: Message) => void;
  onDiscard: (message: Message) => void;
  onJumpToMessage: (messageId: string) => void;
}

function MessageBubble({
  message,
  mine,
  highlighted,
  now,
  confirmRecall,
  onReply,
  onCopy,
  onRecallIntent,
  onRecall,
  onRetry,
  onDiscard,
  onJumpToMessage,
}: MessageBubbleProps) {
  const hasAttachment = message.attachments.length > 0;
  const hasText = Boolean(message.textContent);
  const recalled = Boolean(message.recalledAt);
  const failed = message.deliveryState === "FAILED";
  const sending = message.deliveryState === "SENDING";
  const receipt = mine && !message.deliveryState && !recalled ? receiptText(message) : null;
  const canRecall =
    mine &&
    !message.deliveryState &&
    !recalled &&
    new Date(message.recallableUntil).getTime() >= now;

  return (
    <div
      id={`message-${message.id}`}
      className={`message-row ${mine ? "is-mine" : "is-peer"} ${hasAttachment ? "has-attachment" : ""} ${hasText ? "has-text" : ""} ${highlighted ? "message-highlight" : ""} ${failed ? "is-failed" : ""}`}
    >
      {!mine && <Avatar name={message.senderName} color={message.senderAvatarColor} size="small" />}
      <div className="message-stack">
        {!mine && <span className="sender-name">{message.senderName}</span>}
        <div className="message-content">
          {message.replyTo && !recalled && (
            <button
              className="message-quote"
              type="button"
              onClick={() => onJumpToMessage(message.replyTo!.id)}
              title="定位到被引用的消息"
            >
              <span>{message.replyTo.senderName}</span>
              <strong>{replySummary(message.replyTo)}</strong>
            </button>
          )}

          {recalled ? (
            <div className="message-recalled">
              <RotateCcw size={14} />
              {mine ? "你撤回了一条消息" : `${message.senderName} 撤回了一条消息`}
            </div>
          ) : (
            <>
              {message.attachments.map((attachment) => (
                <AttachmentView attachment={attachment} key={attachment.id} />
              ))}
              {message.textContent && (
                <div className={`message-bubble ${mine ? "mine-bubble" : "peer-bubble"}`}>
                  {message.textContent}
                </div>
              )}
            </>
          )}
        </div>

        {failed && (
          <div className="message-failure" role="status">
            <span>{message.sendError ?? "发送失败"}</span>
            <button type="button" onClick={() => onRetry(message)}>
              <RefreshCw size={12} />
              重试
            </button>
            <button type="button" onClick={() => onDiscard(message)}>
              <Trash2 size={12} />
              删除
            </button>
          </div>
        )}

        <div className="message-footer">
          {!recalled && !failed && !sending && (
            <div className="message-actions" aria-label="消息操作">
              <button type="button" onClick={() => onReply(message)} title="回复" aria-label="回复">
                <Reply size={15} />
              </button>
              {message.textContent && (
                <button
                  type="button"
                  onClick={() => onCopy(message)}
                  title="复制文本"
                  aria-label="复制文本"
                >
                  <Copy size={15} />
                </button>
              )}
              {canRecall &&
                (confirmRecall ? (
                  <span className="recall-confirm">
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        onRecallIntent(null);
                        onRecall(message);
                      }}
                      title="确认撤回"
                      aria-label="确认撤回"
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRecallIntent(null)}
                      title="取消撤回"
                      aria-label="取消撤回"
                    >
                      <X size={15} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRecallIntent(message.id)}
                    title="撤回"
                    aria-label="撤回"
                  >
                    <RotateCcw size={15} />
                  </button>
                ))}
            </div>
          )}

          <span className="message-meta">
            <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
            {sending && (
              <span className="message-delivery-state">
                <LoaderCircle className="spin" size={12} /> 发送中
              </span>
            )}
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
    </div>
  );
}

/** 当前会话的纯展示模块，不负责请求、已读状态或实时连接。 */
export function MessageTimeline({
  conversation,
  messages,
  currentUserId,
  loading,
  loadingOlder,
  hasMore,
  endRef,
  highlightedMessageId,
  onLoadOlder,
  onReply,
  onCopy,
  onRecall,
  onRetry,
  onDiscard,
  onJumpToMessage,
}: MessageTimelineProps) {
  const [now, setNow] = useState(Date.now());
  const [recallCandidateId, setRecallCandidateId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

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

      {!loading && messages.length > 0 && hasMore && (
        <button
          className="load-older-button"
          type="button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
        >
          {loadingOlder ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loadingOlder ? "正在加载历史消息" : "加载更早消息"}
        </button>
      )}

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
              now={now}
              confirmRecall={recallCandidateId === message.id}
              onReply={onReply}
              onCopy={onCopy}
              onRecallIntent={setRecallCandidateId}
              onRecall={onRecall}
              onRetry={onRetry}
              onDiscard={onDiscard}
              onJumpToMessage={onJumpToMessage}
            />
          </Fragment>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
