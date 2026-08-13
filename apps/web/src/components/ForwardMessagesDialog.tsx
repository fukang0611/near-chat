import { ArrowRight, Check, Forward, LoaderCircle, Search, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation, Message } from "../types";
import { errorMessage } from "../utils/errors";
import { isFlashRoomExpired } from "../utils/flash-room";
import { messageSummary } from "../utils/message";
import { Avatar } from "./Avatar";
import { FlashRoomBadge } from "./FlashRoomBadge";

interface ForwardMessagesDialogProps {
  conversations: Conversation[];
  messages: Message[];
  onClose: () => void;
  onForward: (conversationId: string) => Promise<boolean>;
}

/** 目标会话选择器保持单目标语义，确保一次提交要么完整成功、要么不留下半批消息。 */
export function ForwardMessagesDialog({
  conversations,
  messages,
  onClose,
  onForward,
}: ForwardMessagesDialogProps) {
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredConversations = useMemo(() => {
    const normalized = keyword.trim().toLocaleLowerCase("zh-CN");
    return conversations.filter(
      (conversation) =>
        !normalized ||
        conversation.title.toLocaleLowerCase("zh-CN").includes(normalized) ||
        conversation.members.some(
          (member) =>
            member.displayName.toLocaleLowerCase("zh-CN").includes(normalized) ||
            member.username.toLocaleLowerCase("zh-CN").includes(normalized),
        ),
    );
  }, [conversations, keyword]);

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, submitting]);

  const submit = async () => {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (await onForward(selectedId)) onClose();
    } catch (forwardError) {
      setError(errorMessage(forwardError, "消息转发失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="forward-dialog-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}
    >
      <section
        className="forward-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-dialog-title"
      >
        <header>
          <span aria-hidden="true">
            <Forward size={20} />
          </span>
          <div>
            <strong id="forward-dialog-title">转发 {messages.length} 条消息</strong>
            <small>选择一个目标会话，消息将按原顺序逐条发送</small>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="关闭转发">
            <X size={18} />
          </button>
        </header>

        <div className="forward-preview" aria-label="待转发内容预览">
          {messages.slice(0, 3).map((message) => (
            <span key={message.id}>
              <b>{message.senderName}</b>
              {messageSummary(message)}
            </span>
          ))}
          {messages.length > 3 && <em>另有 {messages.length - 3} 条消息</em>}
        </div>

        <label className="forward-search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索会话或成员"
            aria-label="搜索转发目标"
          />
          {keyword && (
            <button type="button" onClick={() => setKeyword("")} aria-label="清除目标搜索">
              <X size={14} />
            </button>
          )}
        </label>

        <div className="forward-conversation-list" role="listbox" aria-label="选择转发目标">
          {filteredConversations.length === 0 ? (
            <div className="forward-empty">
              <UsersRound size={22} />
              <strong>没有匹配的会话</strong>
              <span>换个名称或成员关键词试试</span>
            </div>
          ) : (
            filteredConversations.map((conversation) => {
              const expired = isFlashRoomExpired(conversation.expiresAt);
              const selected = selectedId === conversation.id;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "is-selected" : ""}
                  key={conversation.id}
                  disabled={expired}
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <Avatar
                    name={conversation.title}
                    color={conversation.avatarColor}
                    src={conversation.avatarUrl}
                    online={conversation.type === "DIRECT" ? conversation.peer?.online : undefined}
                  />
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      {expired
                        ? "闪聊已结束"
                        : conversation.type === "GROUP"
                          ? `${conversation.memberCount} 位成员`
                          : conversation.peer?.online
                            ? "在线"
                            : "离线，可正常接收"}
                    </small>
                  </span>
                  <FlashRoomBadge expiresAt={conversation.expiresAt} compact />
                  <i>{selected && <Check size={14} />}</i>
                </button>
              );
            })
          )}
        </div>

        {error && (
          <div className="forward-error" role="alert">
            {error}
          </div>
        )}

        <footer>
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={!selectedId || submitting}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            {submitting ? "正在转发" : "确认转发"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
