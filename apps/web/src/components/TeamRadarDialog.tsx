import {
  Activity,
  ArrowUpRight,
  CheckCheck,
  Inbox,
  MessageCircleMore,
  Radar,
  RefreshCw,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Conversation, TeamRadar as TeamRadarData } from "../types";
import { errorMessage } from "../utils/errors";
import { formatClock } from "../utils/format";
import { Avatar } from "./Avatar";
import { FlashRoomBadge } from "./FlashRoomBadge";
import { UserStatusBubble } from "./UserStatusBubble";

interface TeamRadarDialogProps {
  conversations: Conversation[];
  currentUserId: string;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

function todayLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}

function radarMessagePreview(
  signal: { lastMessage: TeamRadarData["activeConversations"][number]["lastMessage"] },
  conversation: Conversation,
): string {
  const prefix = conversation.type === "GROUP" ? `${signal.lastMessage.senderName}: ` : "";
  if (signal.lastMessage.text) return `${prefix}${signal.lastMessage.text}`;
  if (signal.lastMessage.type === "IMAGE") return `${prefix}[图片]`;
  if (signal.lastMessage.type === "AUDIO") return `${prefix}[语音明信片]`;
  if (signal.lastMessage.type === "FILE") return `${prefix}[附件]`;
  return `${prefix}新消息`;
}

/**
 * 团队雷达只呈现当天协作线索：谁在线、哪些会话有动静、还有哪些消息待读。
 * 不展示个人发送量，也不生成成员排行。
 */
export function TeamRadarDialog({
  conversations,
  currentUserId,
  onClose,
  onOpenConversation,
}: TeamRadarDialogProps) {
  const [radar, setRadar] = useState<TeamRadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const radarRef = useRef<TeamRadarData | null>(null);
  const requestIdRef = useRef(0);

  const loadRadar = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (radarRef.current) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await api.teamRadar();
      if (requestId !== requestIdRef.current) return;
      radarRef.current = result;
      setRadar(result);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(errorMessage(loadError, "团队雷达暂时无法扫描"));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadRadar();
    const refreshTimer = window.setInterval(() => void loadRadar(), 30_000);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      requestIdRef.current += 1;
      window.clearInterval(refreshTimer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [loadRadar, onClose]);

  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );
  const activeConversations = useMemo(
    () =>
      (radar?.activeConversations ?? []).flatMap((activity) => {
        const conversation = conversationById.get(activity.conversationId);
        return conversation ? [{ activity, conversation }] : [];
      }),
    [conversationById, radar?.activeConversations],
  );
  const unreadConversations = useMemo(
    () =>
      (radar?.unreadConversations ?? []).flatMap((unread) => {
        const conversation = conversationById.get(unread.conversationId);
        return conversation ? [{ unread, conversation }] : [];
      }),
    [conversationById, radar?.unreadConversations],
  );
  const unreadTotal = (radar?.unreadConversations ?? []).reduce(
    (total, conversation) => total + conversation.unreadCount,
    0,
  );

  const openConversation = (conversationId: string) => {
    onOpenConversation(conversationId);
    onClose();
  };

  return createPortal(
    <div
      className="team-radar-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="team-radar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-radar-title"
      >
        <header className="team-radar-header">
          <div className="team-radar-scope" aria-hidden="true">
            <i />
            <i />
            <i />
            <span />
            <b />
            <b />
            <b />
            <Radar size={23} />
          </div>
          <div className="team-radar-heading">
            <span>NEARBY PULSE</span>
            <strong id="team-radar-title">今日团队雷达</strong>
            <small>{radar ? todayLabel(radar.dayStartedAt) : "正在读取今天的协作信号"}</small>
          </div>
          <div className="team-radar-header-actions">
            {radar && <small>更新于 {formatClock(radar.generatedAt)}</small>}
            <button
              type="button"
              onClick={() => void loadRadar()}
              disabled={loading || refreshing}
              aria-label="刷新团队雷达"
              title="刷新"
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={17} />
            </button>
            <button type="button" onClick={onClose} aria-label="关闭团队雷达">
              <X size={18} />
            </button>
          </div>
        </header>

        {loading && !radar ? (
          <div className="team-radar-loading" role="status">
            <span className="team-radar-loading-scope">
              <Radar size={24} />
            </span>
            <strong>正在扫描局域网里的协作信号</strong>
            <small>汇总在线状态、今天的会话与待读消息</small>
          </div>
        ) : error && !radar ? (
          <div className="team-radar-error" role="alert">
            <Radar size={25} />
            <strong>这次没有扫到信号</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void loadRadar()}>
              <RefreshCw size={15} /> 重新扫描
            </button>
          </div>
        ) : radar ? (
          <div className="team-radar-body">
            {error && (
              <div className="team-radar-inline-error" role="status">
                {error}，当前仍显示上次结果
              </div>
            )}

            <div className="team-radar-stats">
              <article className="team-radar-stat is-online">
                <span>
                  <UsersRound size={18} />
                </span>
                <div>
                  <strong>{radar.onlineMembers.length}</strong>
                  <small>人当前在线</small>
                </div>
                <em>共 {radar.totalMemberCount} 位成员</em>
              </article>
              <article className="team-radar-stat is-active">
                <span>
                  <Activity size={18} />
                </span>
                <div>
                  <strong>{radar.activeConversations.length}</strong>
                  <small>个会话有动静</small>
                </div>
                <em>今天 {radar.todayMessageCount} 条消息</em>
              </article>
              <article className="team-radar-stat is-unread">
                <span>
                  <Inbox size={18} />
                </span>
                <div>
                  <strong>{unreadTotal}</strong>
                  <small>条消息待读</small>
                </div>
                <em>{unreadTotal ? "从卡片直接处理" : "现在很清爽"}</em>
              </article>
            </div>

            <section className="team-radar-online-section">
              <div className="team-radar-section-heading">
                <span>
                  <i /> 身边在线
                </span>
                <small>实时连接中的团队成员</small>
              </div>
              {radar.onlineMembers.length > 0 ? (
                <div className="team-radar-people">
                  {radar.onlineMembers.map((member) => (
                    <div className="team-radar-person" key={member.id}>
                      <Avatar
                        name={member.displayName}
                        color={member.avatarColor}
                        src={member.avatarUrl}
                        online
                        size="small"
                      />
                      <span>
                        <strong>
                          {member.displayName}
                          {member.id === currentUserId && <em>你</em>}
                        </strong>
                        {member.status ? (
                          <UserStatusBubble status={member.status} />
                        ) : (
                          <small>@{member.username}</small>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="team-radar-mini-empty">暂时没有成员保持实时连接</div>
              )}
            </section>

            <div className="team-radar-columns">
              <section className="team-radar-column">
                <div className="team-radar-section-heading">
                  <span>
                    <MessageCircleMore size={14} /> 今天有动静
                  </span>
                  <small>{activeConversations.length} 个可见会话</small>
                </div>
                <div className="team-radar-conversation-list">
                  {activeConversations.length > 0 ? (
                    activeConversations.map(({ activity, conversation }) => (
                      <button
                        type="button"
                        className="team-radar-conversation"
                        key={conversation.id}
                        onClick={() => openConversation(conversation.id)}
                      >
                        <Avatar
                          name={conversation.title}
                          color={conversation.avatarColor}
                          src={conversation.avatarUrl}
                          size="small"
                        />
                        <span>
                          <span>
                            <strong>{conversation.title}</strong>
                            <FlashRoomBadge expiresAt={conversation.expiresAt} compact />
                            <time>{formatClock(activity.lastActivityAt)}</time>
                          </span>
                          <small>{radarMessagePreview(activity, conversation)}</small>
                          <em>今天 {activity.messageCount} 条消息</em>
                        </span>
                        <ArrowUpRight size={15} />
                      </button>
                    ))
                  ) : (
                    <div className="team-radar-empty-card">
                      <MessageCircleMore size={20} />
                      <strong>今天还很安静</strong>
                      <span>第一条消息出现后，会话会在这里亮起。</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="team-radar-column">
                <div className="team-radar-section-heading">
                  <span>
                    <Inbox size={14} /> 待读信号
                  </span>
                  <small>{unreadConversations.length} 个会话</small>
                </div>
                <div className="team-radar-conversation-list">
                  {unreadConversations.length > 0 ? (
                    unreadConversations.map(({ unread, conversation }) => (
                      <button
                        type="button"
                        className="team-radar-conversation is-unread"
                        key={conversation.id}
                        onClick={() => openConversation(conversation.id)}
                      >
                        <Avatar
                          name={conversation.title}
                          color={conversation.avatarColor}
                          src={conversation.avatarUrl}
                          size="small"
                        />
                        <span>
                          <span>
                            <strong>{conversation.title}</strong>
                            <time>{formatClock(unread.latestUnreadAt)}</time>
                          </span>
                          <small>{radarMessagePreview(unread, conversation)}</small>
                          <em>{unread.unreadCount} 条待读</em>
                        </span>
                        <b>{unread.unreadCount > 99 ? "99+" : unread.unreadCount}</b>
                      </button>
                    ))
                  ) : (
                    <div className="team-radar-empty-card is-clear">
                      <CheckCheck size={21} />
                      <strong>消息已经全部读完</strong>
                      <span>没有悬而未读的会话，可以安心继续手头工作。</span>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <footer className="team-radar-footer">
              <Radar size={13} />
              这里只呈现团队协作线索，不统计个人产出，也不生成成员排名。
            </footer>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
