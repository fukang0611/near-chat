import {
  AppWindow,
  ClipboardPaste,
  HardDrive,
  LogOut,
  MessageCircleMore,
  MoreHorizontal,
  Radio,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  UserRoundCog,
  UserRoundPlus,
  UsersRound,
  X,
} from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConnectionState } from "../hooks/useRealtimeConnection";
import type { Attachment, Conversation, User } from "../types";
import { formatConversationPreview, formatSidebarTime } from "../utils/format";
import type { ThemeMode } from "../utils/theme";
import { Avatar } from "./Avatar";
import { FlashRoomBadge } from "./FlashRoomBadge";
import { ThemeToggle } from "./ThemeToggle";
import { UserStatusBubble } from "./UserStatusBubble";

export type SidebarMode = "recent" | "people";

/** 联系人头像接收的原始投递内容；校验与真正发送由聊天页统一编排。 */
export type ContactDropPayload = { kind: "files"; files: File[] } | { kind: "text"; text: string };

export interface ContactDeliveryProgress {
  peerId: string;
  label: string;
  progress: number | null;
}

function supportsContactDrop(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return types.includes("Files") || types.includes("text/plain") || types.includes("text");
}

function readContactDrop(dataTransfer: DataTransfer): ContactDropPayload | null {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return { kind: "files", files };
  const text = (dataTransfer.getData("text/plain") || dataTransfer.getData("text")).trim();
  return text ? { kind: "text", text } : null;
}

function ContactDropCue({
  targetName,
  highlighted,
  delivery,
}: {
  targetName: string;
  highlighted: boolean;
  delivery: ContactDeliveryProgress | null;
}) {
  if (delivery) {
    return (
      <span className="contact-drop-cue is-progress" aria-live="polite">
        <Send size={15} />
        <span>
          <strong>{delivery.label}</strong>
          {delivery.progress === null ? "正在投递" : `${delivery.progress}%`}
        </span>
        {delivery.progress !== null && <i style={{ width: `${delivery.progress}%` }} />}
      </span>
    );
  }
  if (!highlighted) return null;
  return (
    <span className="contact-drop-cue" aria-hidden="true">
      <Send size={15} />
      松开发送给 {targetName}
    </span>
  );
}

interface ChatSidebarProps {
  currentUser: User;
  users: User[];
  conversations: Conversation[];
  selectedId: string | null;
  drafts: Record<string, string>;
  pendingAttachments: Record<string, Attachment>;
  loading: boolean;
  connection: ConnectionState;
  theme: ThemeMode;
  mode: SidebarMode;
  contactDelivery: ContactDeliveryProgress | null;
  contactDropBusy: boolean;
  onThemeChange: (theme: ThemeMode) => void;
  onModeChange: (mode: SidebarMode) => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenDirect: (userId: string) => void;
  onDropToContact: (userId: string, payload: ContactDropPayload) => void;
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
  theme,
  mode,
  contactDelivery,
  contactDropBusy,
  onThemeChange,
  onModeChange,
  onSelectConversation,
  onOpenDirect,
  onDropToContact,
  onCreateGroup,
  onOpenProfile,
  onOpenAdmin,
  onLogout,
}: ChatSidebarProps) {
  const [search, setSearch] = useState("");
  const [showSystemMenu, setShowSystemMenu] = useState(false);
  const [clipboardRelayStatus, setClipboardRelayStatus] =
    useState<DesktopClipboardRelayStatus | null>(null);
  const [desktopIslandStatus, setDesktopIslandStatus] = useState<DesktopIslandStatus | null>(null);
  const [contactDropTargetId, setContactDropTargetId] = useState<string | null>(null);
  const systemMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const desktop = window.nearChatDesktop;
    void desktop?.getClipboardRelayStatus().then((status) => {
      if (active) setClipboardRelayStatus(status);
    });
    void desktop?.getDesktopIslandStatus?.().then((status) => {
      if (active) setDesktopIslandStatus(status);
    });
    const unsubscribe = desktop?.onDesktopIslandStatusChanged?.((status) => {
      if (active) setDesktopIslandStatus(status);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  /** 拖入即建立空间对应关系，目标行从指针进入开始持续反馈。 */
  const handleContactDrag = (event: DragEvent<HTMLButtonElement>, peerId: string) => {
    if (!supportsContactDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = contactDropBusy ? "none" : "copy";
    if (!contactDropBusy) setContactDropTargetId(peerId);
  };

  const handleContactDragLeave = (event: DragEvent<HTMLButtonElement>, peerId: string) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setContactDropTargetId((current) => (current === peerId ? null : current));
  };

  const handleContactDrop = (event: DragEvent<HTMLButtonElement>, peerId: string) => {
    if (!supportsContactDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setContactDropTargetId(null);
    const payload = readContactDrop(event.dataTransfer);
    if (payload) onDropToContact(peerId, payload);
  };

  /**
   * 系统信息面板挂在右上角按钮上，但按钮不一定靠近侧栏右边缘（例如 Electron
   * 隐藏原生窗口控制占位时）。这里以侧栏和视口的交集为安全区域，动态夹取横向
   * 位置，避免固定偏移在窄窗口、系统缩放或不同平台字体下把面板推到屏幕外。
   */
  const updateSystemMenuPosition = useCallback(() => {
    const anchor = systemMenuRef.current;
    const popover = anchor?.querySelector<HTMLElement>(".system-popover");
    const sidebar = anchor?.closest<HTMLElement>(".sidebar");
    if (!anchor || !popover || !sidebar) return;

    const viewportMargin = 12;
    const anchorRect = anchor.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const popoverWidth = popover.offsetWidth;
    const safeLeft = Math.max(viewportMargin, sidebarRect.left + viewportMargin);
    const safeRight = Math.min(
      window.innerWidth - viewportMargin,
      sidebarRect.right - viewportMargin,
    );
    const latestLeft = anchorRect.right - popoverWidth;
    const maximumLeft = Math.max(safeLeft, safeRight - popoverWidth);
    const popoverLeft = Math.min(Math.max(latestLeft, safeLeft), maximumLeft);
    const relativeLeft = popoverLeft - anchorRect.left;
    const originX = Math.min(popoverWidth - 18, Math.max(18, anchorRect.width / 2 - relativeLeft));

    anchor.style.setProperty("--system-popover-left", `${relativeLeft}px`);
    anchor.style.setProperty("--system-popover-origin-x", `${originX}px`);
  }, []);

  useLayoutEffect(() => {
    if (!showSystemMenu) return;

    updateSystemMenuPosition();
    window.addEventListener("resize", updateSystemMenuPosition);

    const anchor = systemMenuRef.current;
    const sidebar = anchor?.closest<HTMLElement>(".sidebar");
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSystemMenuPosition);
    if (anchor) resizeObserver?.observe(anchor);
    if (sidebar) resizeObserver?.observe(sidebar);

    return () => {
      window.removeEventListener("resize", updateSystemMenuPosition);
      resizeObserver?.disconnect();
    };
  }, [showSystemMenu, updateSystemMenuPosition]);

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
        <div className="sidebar-top-actions">
          <ThemeToggle compact theme={theme} onChange={onThemeChange} />
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
                {window.nearChatDesktop && (
                  <>
                    <button
                      className={`system-settings-row clipboard-relay-row ${clipboardRelayStatus && !clipboardRelayStatus.registered ? "has-warning" : ""}`}
                      type="button"
                      onClick={() => {
                        setShowSystemMenu(false);
                        void window.nearChatDesktop?.requestClipboardRelay();
                      }}
                    >
                      <ClipboardPaste size={16} />
                      <span>
                        <strong>剪贴板接力</strong>
                        <small>{clipboardRelayStatus?.message ?? "正在读取快捷键状态"}</small>
                      </span>
                    </button>
                    <button
                      className="system-settings-row desktop-island-row"
                      type="button"
                      aria-pressed={desktopIslandStatus?.enabled ?? false}
                      onClick={() => {
                        void window.nearChatDesktop
                          ?.setDesktopIslandEnabled(!(desktopIslandStatus?.enabled ?? false))
                          .then(setDesktopIslandStatus);
                      }}
                    >
                      <AppWindow size={16} />
                      <span>
                        <strong>桌面浮岛</strong>
                        <small>
                          {desktopIslandStatus?.enabled
                            ? "已置顶显示，可快速查看与回复"
                            : "开启置顶的最近会话小窗"}
                        </small>
                      </span>
                      <i className={desktopIslandStatus?.enabled ? "is-on" : ""} />
                    </button>
                    <button
                      className="system-settings-row"
                      type="button"
                      onClick={() => {
                        setShowSystemMenu(false);
                        void window.nearChatDesktop?.openServerSettings();
                      }}
                    >
                      <Settings2 size={16} />
                      <span>
                        <strong>服务器设置</strong>
                        <small>更换当前连接的局域网服务</small>
                      </span>
                    </button>
                  </>
                )}
                <footer>
                  <ShieldCheck size={13} />
                  消息和文件仅保存在当前局域网
                </footer>
              </div>
            )}
          </div>
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
              filteredConversations.map((conversation) => {
                const dropPeerId =
                  conversation.type === "DIRECT" ? conversation.peer?.id : undefined;
                const isDropTarget = dropPeerId === contactDropTargetId;
                const isDelivering = dropPeerId === contactDelivery?.peerId;
                return (
                  <button
                    type="button"
                    className={`conversation-item ${selectedId === conversation.id ? "is-selected" : ""} ${isDropTarget ? "is-contact-drop-target" : ""} ${isDelivering ? "is-contact-delivering" : ""}`}
                    key={conversation.id}
                    onClick={() => onSelectConversation(conversation.id)}
                    onDragEnter={
                      dropPeerId ? (event) => handleContactDrag(event, dropPeerId) : undefined
                    }
                    onDragOver={
                      dropPeerId ? (event) => handleContactDrag(event, dropPeerId) : undefined
                    }
                    onDragLeave={
                      dropPeerId ? (event) => handleContactDragLeave(event, dropPeerId) : undefined
                    }
                    onDrop={
                      dropPeerId ? (event) => handleContactDrop(event, dropPeerId) : undefined
                    }
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                  >
                    <Avatar
                      name={conversation.title}
                      color={conversation.avatarColor}
                      src={conversation.avatarUrl}
                      online={
                        conversation.type === "DIRECT" ? conversation.peer?.online : undefined
                      }
                    />
                    <span className="conversation-copy">
                      <span>
                        <strong>{conversation.title}</strong>
                        <FlashRoomBadge expiresAt={conversation.expiresAt} compact />
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
                          ) : conversation.type === "DIRECT" && conversation.peer?.status ? (
                            <UserStatusBubble status={conversation.peer.status} compact />
                          ) : (
                            formatConversationPreview(conversation)
                          )}
                        </small>
                        {conversation.unreadCount > 0 && (
                          <b>{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</b>
                        )}
                      </span>
                    </span>
                    <ContactDropCue
                      targetName={conversation.title}
                      highlighted={isDropTarget}
                      delivery={isDelivering ? contactDelivery : null}
                    />
                  </button>
                );
              })
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
                className={`conversation-item people-item ${contactDropTargetId === peer.id ? "is-contact-drop-target" : ""} ${contactDelivery?.peerId === peer.id ? "is-contact-delivering" : ""}`}
                key={peer.id}
                onClick={() => onOpenDirect(peer.id)}
                onDragEnter={(event) => handleContactDrag(event, peer.id)}
                onDragOver={(event) => handleContactDrag(event, peer.id)}
                onDragLeave={(event) => handleContactDragLeave(event, peer.id)}
                onDrop={(event) => handleContactDrop(event, peer.id)}
              >
                <Avatar
                  name={peer.displayName}
                  color={peer.avatarColor}
                  src={peer.avatarUrl}
                  online={peer.online}
                />
                <span className="conversation-copy">
                  <span>
                    <strong>{peer.displayName}</strong>
                  </span>
                  <span>
                    <small className="people-presence-line">
                      {peer.status ? (
                        <UserStatusBubble status={peer.status} compact />
                      ) : (
                        <>
                          @{peer.username} · {peer.online ? "在线" : "离线，仍可留言"}
                        </>
                      )}
                    </small>
                  </span>
                </span>
                <span className="chat-action">
                  <MessageCircleMore size={16} />
                </span>
                <ContactDropCue
                  targetName={peer.displayName}
                  highlighted={contactDropTargetId === peer.id}
                  delivery={contactDelivery?.peerId === peer.id ? contactDelivery : null}
                />
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
          src={currentUser.avatarUrl}
          size="small"
          online={connection === "connected"}
        />
        <span>
          <strong>{currentUser.displayName}</strong>
          <small>
            {currentUser.status ? (
              <UserStatusBubble status={currentUser.status} compact />
            ) : (
              <>
                <i className={`profile-status ${connection}`} />
                {connection === "connected"
                  ? "已连接局域网"
                  : connection === "connecting"
                    ? "正在连接"
                    : "连接已断开"}
              </>
            )}
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
