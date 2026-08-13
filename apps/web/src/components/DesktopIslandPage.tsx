import {
  ArrowUpRight,
  LoaderCircle,
  MessageCircleMore,
  Minus,
  Send,
  Wifi,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useRealtimeConnection } from "../hooks/useRealtimeConnection";
import type { Conversation, Message, User } from "../types";
import { createClientMessageId } from "../utils/client-id";
import { errorMessage } from "../utils/errors";
import { formatClock, formatConversationPreview } from "../utils/format";
import { messageSummary } from "../utils/message";
import { Avatar } from "./Avatar";

interface DesktopIslandPageProps {
  user: User;
  onSessionInvalid: () => void;
}

function upsertMessage(current: Message[], incoming: Message): Message[] {
  const next = current.filter(
    (message) => message.id !== incoming.id && message.clientMessageId !== incoming.clientMessageId,
  );
  return [...next, incoming]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    .slice(-12);
}

/**
 * Electron 桌面浮岛只保留最近会话、短消息预览与文本发送三件事。所有数据仍来自
 * 标准 API 和 WebSocket，因此主窗口、浏览器与浮岛天然保持同一份服务端状态。
 */
export function DesktopIslandPage({ user, onSessionInvalid }: DesktopIslandPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const recentConversations = conversations.slice(0, 4);

  useEffect(() => {
    document.body.classList.add("desktop-island-body");
    return () => document.body.classList.remove("desktop-island-body");
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refreshConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    setSelectedId((current) =>
      current && result.conversations.some((conversation) => conversation.id === current)
        ? current
        : (result.conversations[0]?.id ?? null),
    );
    return result.conversations;
  }, []);

  useEffect(() => {
    void refreshConversations()
      .catch((caught) => setError(errorMessage(caught, "会话加载失败")))
      .finally(() => setLoading(false));
  }, [refreshConversations]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let active = true;
    setError(null);
    void api
      .messages(selectedId, { limit: 12 })
      .then((result) => {
        if (!active) return;
        setMessages(result.messages);
        const latest = result.messages.at(-1);
        if (latest && latest.senderId !== user.id) {
          void api.markRead(selectedId, latest.id).catch(() => undefined);
        }
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught, "消息加载失败"));
      });
    return () => {
      active = false;
    };
  }, [selectedId, user.id]);

  const connection = useRealtimeConnection({
    onSessionInvalid,
    onPresenceSnapshot: (onlineUserIds) => {
      const onlineIds = new Set(onlineUserIds);
      setConversations((current) =>
        current.map((conversation) => ({
          ...conversation,
          peer: conversation.peer
            ? { ...conversation.peer, online: onlineIds.has(conversation.peer.id) }
            : null,
          members: conversation.members.map((member) => ({
            ...member,
            online: onlineIds.has(member.id),
          })),
        })),
      );
      void refreshConversations().catch(() => undefined);
    },
    onPresenceChanged: (changedUserId, online) => {
      setConversations((current) =>
        current.map((conversation) => ({
          ...conversation,
          peer:
            conversation.peer?.id === changedUserId
              ? { ...conversation.peer, online }
              : conversation.peer,
          members: conversation.members.map((member) =>
            member.id === changedUserId ? { ...member, online } : member,
          ),
        })),
      );
    },
    onUsersChanged: () => void refreshConversations().catch(() => undefined),
    onMessageCreated: (incoming) => {
      if (incoming.conversationId === selectedIdRef.current) {
        setMessages((current) => upsertMessage(current, incoming));
      }
      void refreshConversations().catch(() => undefined);
    },
    onMessageUpdated: (incoming) => {
      if (incoming.conversationId === selectedIdRef.current) {
        setMessages((current) => upsertMessage(current, incoming));
      }
      void refreshConversations().catch(() => undefined);
    },
    onUnreadChanged: (conversationId, unreadCount) => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, unreadCount } : conversation,
        ),
      );
    },
    onConversationChanged: () => void refreshConversations().catch(() => undefined),
    onReceiptChanged: () => undefined,
    onNudgeReceived: () => undefined,
  });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!selectedId || !text || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.sendMessage(selectedId, {
        clientMessageId: createClientMessageId(),
        text,
      });
      setMessages((current) => upsertMessage(current, result.message));
      setDraft("");
      await refreshConversations();
    } catch (caught) {
      setError(errorMessage(caught, "发送失败，请稍后重试"));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="desktop-island" aria-label="近聊桌面浮岛">
      <header className="desktop-island-titlebar">
        <span className="desktop-island-brand">
          <MessageCircleMore size={15} />
          <strong>近聊浮岛</strong>
        </span>
        <span className={`desktop-island-connection ${connection}`}>
          {connection === "connected" ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connection === "connected" ? "在线" : "重连中"}
        </span>
        <span className="desktop-island-window-actions">
          <button
            type="button"
            aria-label="在主窗口打开"
            title="在主窗口打开"
            onClick={() => void window.nearChatDesktop?.openMainWindow(selectedId ?? undefined)}
          >
            <ArrowUpRight size={14} />
          </button>
          <button
            type="button"
            aria-label="关闭桌面浮岛"
            title="关闭浮岛"
            onClick={() => void window.nearChatDesktop?.setDesktopIslandEnabled(false)}
          >
            <Minus size={15} />
          </button>
        </span>
      </header>

      <section className="desktop-island-content">
        <div className="desktop-island-overview">
          <span>
            <strong>最近会话</strong>
            <small>
              {conversations.reduce((total, item) => total + item.unreadCount, 0)} 条未读
            </small>
          </span>
        </div>

        <nav className="desktop-island-conversations" aria-label="最近会话">
          {loading ? (
            <div className="desktop-island-loading">
              <LoaderCircle className="spin" size={18} /> 正在同步
            </div>
          ) : recentConversations.length > 0 ? (
            recentConversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={selectedId === conversation.id ? "is-selected" : ""}
                aria-current={selectedId === conversation.id ? "page" : undefined}
                onClick={() => setSelectedId(conversation.id)}
              >
                <Avatar
                  name={conversation.title}
                  color={conversation.avatarColor}
                  src={conversation.avatarUrl}
                  online={conversation.type === "DIRECT" ? conversation.peer?.online : undefined}
                  size="small"
                />
                <span>
                  <strong>{conversation.title}</strong>
                  <small>{formatConversationPreview(conversation)}</small>
                </span>
                {conversation.unreadCount > 0 && (
                  <b>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</b>
                )}
              </button>
            ))
          ) : (
            <div className="desktop-island-empty">还没有会话</div>
          )}
        </nav>

        <div className="desktop-island-chat-head">
          <span>
            <strong>{selectedConversation?.title ?? "选择会话"}</strong>
            <small>
              {selectedConversation?.type === "DIRECT"
                ? selectedConversation.peer?.online
                  ? "在线"
                  : "离线，可留言"
                : selectedConversation
                  ? `${selectedConversation.memberCount} 位成员`
                  : ""}
            </small>
          </span>
          {selectedConversation && (
            <button
              type="button"
              onClick={() => void window.nearChatDesktop?.openMainWindow(selectedConversation.id)}
            >
              查看完整会话
            </button>
          )}
        </div>

        <div className="desktop-island-messages" aria-live="polite">
          {messages.length > 0 ? (
            messages.slice(-6).map((message) => (
              <div
                key={message.id}
                className={`desktop-island-message ${message.senderId === user.id ? "is-own" : ""}`}
              >
                {message.senderId !== user.id && <small>{message.senderName}</small>}
                <span>{messageSummary(message)}</span>
                <time>{formatClock(message.createdAt)}</time>
              </div>
            ))
          ) : (
            <div className="desktop-island-message-empty">
              <MessageCircleMore size={22} />
              <span>{selectedConversation ? "从这里开始一段简短对话" : "选择最近会话"}</span>
            </div>
          )}
        </div>

        {error && <div className="desktop-island-error">{error}</div>}

        <form className="desktop-island-composer" onSubmit={(event) => void send(event)}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              selectedConversation ? `发消息给 ${selectedConversation.title}` : "选择会话"
            }
            maxLength={5000}
            disabled={!selectedConversation || sending}
            aria-label="浮岛消息"
          />
          <button
            type="submit"
            aria-label="发送浮岛消息"
            disabled={!selectedConversation || !draft.trim() || sending}
          >
            {sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          </button>
        </form>
      </section>
    </main>
  );
}

export function DesktopIslandSignedOut() {
  return (
    <main className="desktop-island desktop-island-signed-out">
      <span className="desktop-island-signed-out-mark">
        <MessageCircleMore size={24} />
      </span>
      <strong>先登录近聊</strong>
      <p>浮岛会自动沿用主窗口的登录状态。</p>
      <button type="button" onClick={() => void window.nearChatDesktop?.openMainWindow()}>
        打开主窗口
        <ArrowUpRight size={14} />
      </button>
      <button
        className="is-secondary"
        type="button"
        onClick={() => void window.nearChatDesktop?.setDesktopIslandEnabled(false)}
      >
        暂时关闭浮岛
      </button>
    </main>
  );
}
