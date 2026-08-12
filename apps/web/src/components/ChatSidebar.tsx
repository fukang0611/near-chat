import {
  HardDrive,
  LogOut,
  MessageCircleMore,
  MoreHorizontal,
  Radio,
  Search,
  ShieldCheck,
  UserRoundCog,
  UserRoundPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState } from "../hooks/useRealtimeConnection";
import type { Attachment, Conversation, User } from "../types";
import { formatConversationPreview, formatSidebarTime } from "../utils/format";
import { Avatar } from "./Avatar";

export type SidebarMode = "recent" | "people";

interface ChatSidebarProps {
  currentUser: User;
  users: User[];
  conversations: Conversation[];
  selectedId: string | null;
  drafts: Record<string, string>;
  pendingAttachments: Record<string, Attachment>;
  loading: boolean;
  connection: ConnectionState;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenDirect: (userId: string) => void;
  onCreateGroup: () => void;
  onOpenProfile: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
}

function SidebarSkeleton() {
  return (
    <div className="sidebar-skeleton" aria-label="正在加载会话">
      {[0, 1, 2].map((item) => (
        <div className="skeleton-row" key={item}>
          <span className="skeleton-avatar" />
          <span>
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
}

/** 左侧工作区只负责查找和选择会话，不持有聊天消息或发送状态。 */
export function ChatSidebar({
  currentUser,
  users,
  conversations,
  selectedId,
  drafts,
  pendingAttachments,
  loading,
  connection,
  mode,
  onModeChange,
  onSelectConversation,
  onOpenDirect,
  onCreateGroup,
  onOpenProfile,
  onOpenAdmin,
  onLogout,
}: ChatSidebarProps) {
  const [search, setSearch] = useState("");
  const [showSystemMenu, setShowSystemMenu] = useState(false);
  const systemMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSystemMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!systemMenuRef.current?.contains(event.target as Node)) {
        setShowSystemMenu(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSystemMenu(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [showSystemMenu]);

  const filteredUsers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return [...users]
      .filter(
        (item) =>
          !keyword ||
          item.displayName.toLowerCase().includes(keyword) ||
          item.username.toLowerCase().includes(keyword),
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.online)) - Number(Boolean(left.online)) ||
          left.displayName.localeCompare(right.displayName, "zh-CN"),
      );
  }, [search, users]);

  const filteredConversations = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return conversations.filter(
      (item) =>
        !keyword ||
        item.title.toLowerCase().includes(keyword) ||
        item.members.some(
          (member) =>
            member.displayName.toLowerCase().includes(keyword) ||
            member.username.toLowerCase().includes(keyword),
        ),
    );
  }, [conversations, search]);

  const onlineCount = users.filter((item) => item.online).length;
  const unreadTotal = conversations.reduce((sum, item) => sum + item.unreadCount, 0);

  return (
    <aside className="sidebar">
      <header className="sidebar-top">
        <div className="window-dots" aria-hidden="true">
          <i className="dot-red" />
          <i className="dot-yellow" />
          <i className="dot-green" />
        </div>
        <div className="brand-mini">
          <span className="brand-symbol">
            <MessageCircleMore size={17} />
          </span>
          <strong>近聊</strong>
        </div>
        <div className="system-menu-anchor" ref={systemMenuRef}>
          <button
            className="icon-button"
            type="button"
            aria-label="查看系统信息"
            aria-expanded={showSystemMenu}
            onClick={() => setShowSystemMenu((current) => !current)}
          >
            <MoreHorizontal size={19} />
          </button>
          {showSystemMenu && (
            <div className="system-popover" role="dialog" aria-label="系统信息">
              <header>
                <span className="brand-symbol">
                  <MessageCircleMore size={16} />
                </span>
                <div>
                  <strong>近聊 NearChat</strong>
                  <small>局域网轻量聊天工具</small>
                </div>
              </header>
              <div className="system-status-row">
                <Radio size={16} />
                <span>
                  <strong>实时连接</strong>
                  <small>
                    {connection === "connected"
                      ? "工作正常"
                      : connection === "connecting"
                        ? "正在建立连接"
                        : "正在尝试恢复"}
                  </small>
                </span>
                <i className={connection} />
              </div>
              <div className="system-status-row">
                <HardDrive size={16} />
                <span>
                  <strong>私有文件服务</strong>
                  <small>单文件最大 50 MB</small>
                </span>
              </div>
              <footer>
                <ShieldCheck size={13} />
                消息和文件仅保存在当前局域网
              </footer>
            </div>
          )}
        </div>
      </header>

      <div className="sidebar-main">
        <div className="segmented-control" role="tablist" aria-label="消息导航">
          <button
            className={mode === "recent" ? "is-active" : ""}
            onClick={() => onModeChange("recent")}
            type="button"
            role="tab"
            aria-selected={mode === "recent"}
          >
            <MessageCircleMore size={16} />
            会话
            {unreadTotal > 0 && (
              <b className="segment-badge">{unreadTotal > 99 ? "99+" : unreadTotal}</b>
            )}
          </button>
          <button
            className={mode === "people" ? "is-active" : ""}
            onClick={() => onModeChange("people")}
            type="button"
            role="tab"
            aria-selected={mode === "people"}
          >
            <UsersRound size={16} />
            联系人
          </button>
        </div>

        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={mode === "recent" ? "搜索会话" : "搜索联系人"}
            aria-label={mode === "recent" ? "搜索会话" : "搜索联系人"}
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label="清除搜索">
              <X size={14} />
            </button>
          )}
        </label>

        <div className="list-heading">
          <span>{mode === "recent" ? "最近会话" : "全部联系人"}</span>
          <span className="list-heading-actions">
            <small>
              {mode === "recent" ? `${filteredConversations.length} 个` : `${onlineCount} 在线`}
            </small>
            <button type="button" onClick={onCreateGroup} aria-label="创建群聊" title="创建群聊">
              <UserRoundPlus size={15} />
            </button>
          </span>
        </div>

        <div className="contact-list">
          {loading ? (
            <SidebarSkeleton />
          ) : mode === "recent" ? (
            filteredConversations.length > 0 ? (
              filteredConversations.map((conversation) => (
                <button
                  type="button"
                  className={`conversation-item ${selectedId === conversation.id ? "is-selected" : ""}`}
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                  aria-current={selectedId === conversation.id ? "page" : undefined}
                >
                  <Avatar
                    name={conversation.title}
                    color={conversation.avatarColor}
                    online={conversation.type === "DIRECT" ? conversation.peer?.online : undefined}
                  />
                  <span className="conversation-copy">
                    <span>
                      <strong>{conversation.title}</strong>
                      <time>{formatSidebarTime(conversation.lastMessage?.createdAt)}</time>
                    </span>
                    <span>
                      <small
                        className={
                          drafts[conversation.id]?.trim() || pendingAttachments[conversation.id]
                            ? "has-draft"
                            : ""
                        }
                      >
                        {drafts[conversation.id]?.trim() ? (
                          <>
                            <em>草稿</em>
                            {drafts[conversation.id].trim()}
                          </>
                        ) : pendingAttachments[conversation.id] ? (
                          <>
                            <em>草稿</em>[待发送附件]
                          </>
                        ) : (
                          formatConversationPreview(conversation)
                        )}
                      </small>
                      {conversation.unreadCount > 0 && (
                        <b>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</b>
                      )}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="list-empty">
                <span className="empty-icon">
                  <MessageCircleMore size={22} />
                </span>
                <span>{search ? "没有匹配的会话" : "还没有会话"}</span>
                <small>{search ? "换个关键词试试" : "打开联系人，向身边的人问声好"}</small>
                {!search && (
                  <button type="button" onClick={() => onModeChange("people")}>
                    浏览联系人
                  </button>
                )}
              </div>
            )
          ) : filteredUsers.length > 0 ? (
            filteredUsers.map((peer) => (
              <button
                type="button"
                className="conversation-item people-item"
                key={peer.id}
                onClick={() => onOpenDirect(peer.id)}
              >
                <Avatar name={peer.displayName} color={peer.avatarColor} online={peer.online} />
                <span className="conversation-copy">
                  <span>
                    <strong>{peer.displayName}</strong>
                  </span>
                  <span>
                    <small>
                      @{peer.username} · {peer.online ? "在线" : "离线，仍可留言"}
                    </small>
                  </span>
                </span>
                <span className="chat-action">
                  <MessageCircleMore size={16} />
                </span>
              </button>
            ))
          ) : (
            <div className="list-empty">
              <span className="empty-icon">
                <Search size={22} />
              </span>
              <span>没有匹配的联系人</span>
              <small>检查用户名或显示名称</small>
            </div>
          )}
        </div>
      </div>

      <footer className="sidebar-profile">
        <Avatar
          name={currentUser.displayName}
          color={currentUser.avatarColor}
          size="small"
          online={connection === "connected"}
        />
        <span>
          <strong>{currentUser.displayName}</strong>
          <small>
            <i className={`profile-status ${connection}`} />
            {connection === "connected"
              ? "已连接局域网"
              : connection === "connecting"
                ? "正在连接"
                : "连接已断开"}
          </small>
        </span>
        <button type="button" onClick={onOpenProfile} aria-label="打开个人设置" title="个人设置">
          <UserRoundCog size={17} />
        </button>
        {currentUser.role === "ADMIN" && (
          <button type="button" onClick={onOpenAdmin} aria-label="打开用户管理" title="用户管理">
            <ShieldCheck size={17} />
          </button>
        )}
        <button type="button" onClick={onLogout} aria-label="退出登录" title="退出登录">
          <LogOut size={17} />
        </button>
      </footer>
    </aside>
  );
}
