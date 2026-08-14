import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Hand,
  Info,
  MessageCircleMore,
  Paperclip,
  Search,
  Settings2,
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
import { api } from "../api";
import { useRealtimeConnection } from "../hooks/useRealtimeConnection";
import type {
  Attachment,
  Conversation,
  Message,
  MessageFavorite,
  NudgeEvent,
  User,
} from "../types";
import { createClientMessageId } from "../utils/client-id";
import { errorMessage } from "../utils/errors";
import { messageSummary, toMessageReply } from "../utils/message";
import { messageKindFromContentType } from "../utils/message-kind";
import type { MessageReactionEmoji } from "../utils/reactions";
import { isFlashRoomExpired } from "../utils/flash-room";
import {
  loadNotificationPreferences,
  markNotificationPromptHandled,
  type NotificationPreferences,
  playMessageSound,
  requestNotificationPermission,
  saveNotificationPreferences,
  shouldShowNotificationPrompt,
} from "../utils/notifications";
import type { ThemeMode } from "../utils/theme";
import { AdminPanel } from "./AdminPanel";
import { Avatar } from "./Avatar";
import { ClipboardRelayDialog, type ClipboardRelayContentKind } from "./ClipboardRelayDialog";
import {
  ChatSidebar,
  type ContactDeliveryProgress,
  type ContactDropPayload,
  type SidebarMode,
} from "./ChatSidebar";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { GroupManagementDialog } from "./GroupManagementDialog";
import { FlashRoomBadge } from "./FlashRoomBadge";
import { ForwardMessagesDialog } from "./ForwardMessagesDialog";
import { MessageComposer } from "./MessageComposer";
import { MessageSearchPanel } from "./MessageSearchPanel";
import { MessageAssetsDialog } from "./MessageAssetsDialog";
import { MessageTimeline } from "./MessageTimeline";
import { MessageSelectionToolbar } from "./MessageSelectionToolbar";
import { NotificationPermissionPrompt } from "./NotificationPermissionPrompt";
import { NudgeNotice } from "./NudgeNotice";
import { ProfileDialog } from "./ProfileDialog";
import { ThemeToggle } from "./ThemeToggle";
import { TeamRadarDialog } from "./TeamRadarDialog";
import { UserStatusBubble } from "./UserStatusBubble";

interface ChatPageProps {
  user: User;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onUserUpdated: (user: User) => void;
  onLogout: () => void;
}

type NoticeTone = "success" | "error" | "info";

interface ToastNotice {
  id: number;
  message: string;
  tone: NoticeTone;
}

interface UploadState {
  conversationId: string;
  name: string;
  progress: number;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FORWARD_MESSAGES = 20;

async function clipboardImageFile(payload: DesktopClipboardRelayPayload): Promise<File> {
  if (!payload.imageDataUrl) throw new Error("剪贴板图片不可用");
  const response = await fetch(payload.imageDataUrl);
  const blob = await response.blob();
  const timestamp = payload.capturedAt.replace(/[:.]/g, "-");
  return new File([blob], `剪贴板图片-${timestamp}.png`, {
    type: blob.type || "image/png",
  });
}

function upsertServerMessage(current: Message[], incoming: Message): Message[] {
  const index = current.findIndex(
    (message) =>
      message.id === incoming.id ||
      (message.senderId === incoming.senderId &&
        message.clientMessageId === incoming.clientMessageId),
  );
  if (index < 0) return [...current, incoming];
  return current.map((message, messageIndex) => (messageIndex === index ? incoming : message));
}

function applyMessageUpdate(current: Message[], incoming: Message): Message[] {
  return current.map((message) => {
    if (message.id === incoming.id) return incoming;
    if (message.replyTo?.id === incoming.id && incoming.recalledAt) {
      return {
        ...message,
        replyTo: {
          ...message.replyTo,
          textContent: null,
          attachmentName: null,
          recalled: true,
        },
      };
    }
    return message;
  });
}

/**
 * 聊天页是前端的数据编排层：负责服务端数据、当前会话和领域操作。
 * 侧边栏、消息时间线、编辑器及实时连接各自隐藏浏览器交互细节。
 */
export function ChatPage({ user, theme, onThemeChange, onUserUpdated, onLogout }: ChatPageProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messageLoadVersion, setMessageLoadVersion] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("recent");
  const [favoriteByMessageId, setFavoriteByMessageId] = useState<Record<string, string>>({});
  const [favoriteBusyMessageIds, setFavoriteBusyMessageIds] = useState<Set<string>>(new Set());
  const [messageSelectionMode, setMessageSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [showForwardDialog, setShowForwardDialog] = useState(false);

  // 草稿与待发送附件按会话隔离，切换会话时保留各自上下文。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, Attachment>>({});
  const [replyTargets, setReplyTargets] = useState<Record<string, Message>>({});
  const [outbox, setOutbox] = useState<Record<string, Message[]>>({});
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(
    () => loadNotificationPreferences(user.id),
  );
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);
  const [requestingNotificationPermission, setRequestingNotificationPermission] = useState(false);
  const [notificationPermissionMessage, setNotificationPermissionMessage] = useState<string | null>(
    null,
  );

  const [showAdmin, setShowAdmin] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupManagement, setShowGroupManagement] = useState(false);
  const [showMessageSearch, setShowMessageSearch] = useState(false);
  const [showMessageAssets, setShowMessageAssets] = useState(false);
  const [showTeamRadar, setShowTeamRadar] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [contactDelivery, setContactDelivery] = useState<ContactDeliveryProgress | null>(null);
  const [incomingNudge, setIncomingNudge] = useState<NudgeEvent | null>(null);
  const [nudgingConversationId, setNudgingConversationId] = useState<string | null>(null);
  const [conversationClock, setConversationClock] = useState(Date.now);
  const [clipboardRelayPayload, setClipboardRelayPayload] =
    useState<DesktopClipboardRelayPayload | null>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const notificationPreferencesRef = useRef(notificationPreferences);
  const confirmedClientMessageIdsRef = useRef(new Set<string>());
  const contactDeliveryInFlightRef = useRef(false);
  const scrollActionRef = useRef<
    { type: "bottom" } | { type: "preserve"; previousHeight: number; previousTop: number } | null
  >(null);
  const messageTargetRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const initializedConversationsRef = useRef(false);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const selectedFlashExpired = isFlashRoomExpired(
    selectedConversation?.expiresAt,
    conversationClock,
  );
  const text = selectedId ? (drafts[selectedId] ?? "") : "";
  const pendingAttachment = selectedId ? (pendingAttachments[selectedId] ?? null) : null;
  const replyingTo = selectedId ? (replyTargets[selectedId] ?? null) : null;
  const selectedOutbox = useMemo(
    () => (selectedId ? (outbox[selectedId] ?? []) : []),
    [outbox, selectedId],
  );
  const displayMessages = useMemo(
    () =>
      [...messages, ...selectedOutbox].sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
          left.id.localeCompare(right.id),
      ),
    [messages, selectedOutbox],
  );
  const favoriteMessageIds = useMemo(
    () => new Set(Object.keys(favoriteByMessageId)),
    [favoriteByMessageId],
  );
  const selectableMessages = useMemo(
    () => displayMessages.filter((message) => !message.deliveryState && !message.recalledAt),
    [displayMessages],
  );
  const selectedMessages = useMemo(
    () => selectableMessages.filter((message) => selectedMessageIds.has(message.id)),
    [selectableMessages, selectedMessageIds],
  );
  const clipboardRelayUsers = useMemo(() => {
    const currentUsers = new Map(users.map((candidate) => [candidate.id, candidate]));
    const recentPeerIds = conversations
      .filter((conversation) => conversation.type === "DIRECT" && conversation.peer)
      .map((conversation) => conversation.peer!.id);
    const orderedIds = [...new Set([...recentPeerIds, ...users.map((candidate) => candidate.id)])];
    return orderedIds
      .map((userId) => currentUsers.get(userId))
      .filter((candidate): candidate is User => Boolean(candidate));
  }, [conversations, users]);
  const sending = selectedOutbox.some((message) => message.deliveryState === "SENDING");
  const activeUpload = uploadState?.conversationId === selectedId ? uploadState : null;

  useEffect(() => {
    if (showGroupManagement && selectedConversation?.type !== "GROUP") {
      setShowGroupManagement(false);
    }
  }, [selectedConversation?.type, showGroupManagement]);

  useEffect(() => {
    setMessageSelectionMode(false);
    setSelectedMessageIds(new Set());
    setShowForwardDialog(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedConversation?.expiresAt || selectedFlashExpired) return;
    const timer = window.setInterval(() => setConversationClock(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [selectedConversation?.expiresAt, selectedFlashExpired]);

  const notify = useCallback((message: string, tone: NoticeTone = "error") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!incomingNudge) return;
    const timer = window.setTimeout(() => setIncomingNudge(null), 4_200);
    return () => window.clearTimeout(timer);
  }, [incomingNudge]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(
    () =>
      window.nearChatDesktop?.onNotificationClick((conversationId) => {
        window.focus();
        setSelectedId(conversationId);
      }),
    [],
  );

  useEffect(
    () =>
      window.nearChatDesktop?.onClipboardRelay((payload) => {
        setClipboardRelayPayload(payload);
      }),
    [],
  );

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    notificationPreferencesRef.current = notificationPreferences;
    saveNotificationPreferences(user.id, notificationPreferences);
  }, [notificationPreferences, user.id]);

  useEffect(() => {
    if (notificationPreferences.desktop || !shouldShowNotificationPrompt(user.id)) return;
    // 先让聊天界面稳定呈现，再显示一次性的权限说明，避免登录完成瞬间争抢注意力。
    const timer = window.setTimeout(() => setShowNotificationPrompt(true), 1_200);
    return () => window.clearTimeout(timer);
  }, [notificationPreferences.desktop, user.id]);

  const dismissNotificationPrompt = useCallback(() => {
    markNotificationPromptHandled(user.id);
    setShowNotificationPrompt(false);
    setNotificationPermissionMessage(null);
  }, [user.id]);

  const enableDesktopNotifications = useCallback(async () => {
    setRequestingNotificationPermission(true);
    setNotificationPermissionMessage(null);
    const result = await requestNotificationPermission();
    setRequestingNotificationPermission(false);
    markNotificationPromptHandled(user.id);
    if (result.granted) {
      setNotificationPreferences((current) => ({ ...current, desktop: true }));
      setShowNotificationPrompt(false);
      notify(result.message, "success");
      return;
    }
    setNotificationPermissionMessage(result.message);
  }, [notify, user.id]);

  useEffect(() => {
    const markVisibleConversationRead = () => {
      if (document.visibilityState !== "visible") return;
      const conversationId = selectedIdRef.current;
      const latest = messagesRef.current.at(-1);
      if (!conversationId || !latest || latest.senderId === user.id) return;
      void api.markRead(conversationId, latest.id).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", markVisibleConversationRead);
    return () => document.removeEventListener("visibilitychange", markVisibleConversationRead);
  }, [user.id]);

  const refreshUsers = useCallback(async () => {
    const result = await api.users();
    setUsers(result.users);
    return result.users;
  }, []);

  const refreshConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    // 仅首次加载自动打开第一条会话；移动端主动返回列表后，实时刷新不能把用户拉回去。
    if (!initializedConversationsRef.current) {
      initializedConversationsRef.current = true;
      setSelectedId((current) => current ?? result.conversations[0]?.id ?? null);
    } else {
      // 被移出群聊、主动退出或群聊解散后，及时释放已经失效的选中状态。
      setSelectedId((current) =>
        current && result.conversations.some((item) => item.id === current) ? current : null,
      );
    }
    return result.conversations;
  }, []);

  const refreshConversationsInBackground = useCallback(() => {
    void refreshConversations().catch((error) => {
      notify(errorMessage(error, "会话刷新失败"), "error");
    });
  }, [notify, refreshConversations]);

  useEffect(() => {
    void Promise.all([refreshUsers(), refreshConversations()])
      .catch((error) => notify(errorMessage(error, "数据加载失败"), "error"))
      .finally(() => setSidebarLoading(false));
  }, [notify, refreshConversations, refreshUsers]);

  useEffect(() => {
    let active = true;
    void api
      .messageFavorites()
      .then((result) => {
        if (!active) return;
        setFavoriteByMessageId(
          Object.fromEntries(
            result.favorites.flatMap((favorite) =>
              favorite.sourceMessageId ? [[favorite.sourceMessageId, favorite.id]] : [],
            ),
          ),
        );
      })
      .catch((error) => {
        if (active) notify(errorMessage(error, "收藏状态同步失败"), "error");
      });
    return () => {
      active = false;
    };
  }, [notify, user.id]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setMessageCursor(null);
      setHasMoreMessages(false);
      return;
    }

    let active = true;
    setLoadingMessages(true);
    const target = messageTargetRef.current;
    const aroundMessageId = target?.conversationId === selectedId ? target.messageId : undefined;
    void (async () => {
      try {
        const result = await api.messages(selectedId, { around: aroundMessageId, limit: 50 });
        if (!active) return;
        scrollActionRef.current = aroundMessageId ? null : { type: "bottom" };
        setMessages(result.messages);
        const confirmedClientMessageIds = new Set(
          result.messages
            .filter((message) => message.senderId === user.id)
            .map((message) => message.clientMessageId),
        );
        for (const clientMessageId of confirmedClientMessageIds) {
          confirmedClientMessageIdsRef.current.add(clientMessageId);
        }
        setOutbox((current) => {
          const queued = current[selectedId];
          if (!queued) return current;
          const remaining = queued.filter(
            (message) => !confirmedClientMessageIds.has(message.clientMessageId),
          );
          if (remaining.length === queued.length) return current;
          const next = { ...current };
          if (remaining.length > 0) next[selectedId] = remaining;
          else delete next[selectedId];
          return next;
        });
        setMessageCursor(result.nextCursor);
        setHasMoreMessages(result.hasMore);
        setHighlightedMessageId(aroundMessageId ?? null);
        if (aroundMessageId) messageTargetRef.current = null;
        const latestMessage = result.messages.at(-1);
        const readResult = latestMessage
          ? await api.markRead(selectedId, latestMessage.id)
          : { unreadCount: 0 };
        if (!active) return;
        setConversations((current) =>
          current.map((item) =>
            item.id === selectedId ? { ...item, unreadCount: readResult.unreadCount } : item,
          ),
        );
      } catch (error) {
        if (active) notify(errorMessage(error, "消息加载失败"), "error");
      } finally {
        if (active) setLoadingMessages(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [messageLoadVersion, notify, selectedId]);

  useLayoutEffect(() => {
    const scroll = messageScrollRef.current;
    const action = scrollActionRef.current;
    // 消息数组会先于“标记已读”请求完成；加载占位仍在时不能提前消费滚动动作。
    if (!scroll || !action || loadingMessages) return;
    if (action.type === "bottom") {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      scroll.scrollTop = action.previousTop + (scroll.scrollHeight - action.previousHeight);
    }
    scrollActionRef.current = null;
    // 不能只依赖消息数量：两个会话的消息条数相同时，数组内容仍已整体替换。
    // 依赖实际展示数组，确保会话切换、发送新消息和历史分页都执行各自的滚动动作。
  }, [displayMessages, loadingMessages, selectedId]);

  useEffect(() => {
    // around 消息会先写入状态，标记已读完成前时间线仍显示加载占位。
    // 等真实消息 DOM 挂载后再定位，避免一次性 RAF 提前执行后永远停在列表顶部。
    if (!highlightedMessageId || loadingMessages) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`message-${highlightedMessageId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 2_600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [highlightedMessageId, loadingMessages]);

  const loadOlderMessages = useCallback(async () => {
    const conversationId = selectedId;
    const cursor = messageCursor;
    if (!conversationId || !cursor || !hasMoreMessages || loadingOlder) return;

    const scroll = messageScrollRef.current;
    if (scroll) {
      scrollActionRef.current = {
        type: "preserve",
        previousHeight: scroll.scrollHeight,
        previousTop: scroll.scrollTop,
      };
    }
    setLoadingOlder(true);
    try {
      const result = await api.messages(conversationId, { cursor, limit: 50 });
      if (selectedIdRef.current !== conversationId) return;
      setMessages((current) => {
        const knownIds = new Set(current.map((message) => message.id));
        return [...result.messages.filter((message) => !knownIds.has(message.id)), ...current];
      });
      setMessageCursor(result.nextCursor);
      setHasMoreMessages(result.hasMore);
    } catch (error) {
      scrollActionRef.current = null;
      notify(errorMessage(error, "历史消息加载失败"), "error");
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMoreMessages, loadingOlder, messageCursor, notify, selectedId]);

  const connection = useRealtimeConnection({
    onSessionInvalid: onLogout,
    onPresenceSnapshot: (onlineUserIds) => {
      const onlineIds = new Set(onlineUserIds);
      setUsers((current) => current.map((item) => ({ ...item, online: onlineIds.has(item.id) })));
      setConversations((current) =>
        current.map((item) => {
          const members = item.members.map((member) => ({
            ...member,
            online: onlineIds.has(member.id),
          }));
          const peer = item.peer ? { ...item.peer, online: onlineIds.has(item.peer.id) } : null;
          return {
            ...item,
            members,
            peer,
            onlineMemberCount: members.filter((member) => member.online).length,
          };
        }),
      );
      // 重连时一并补齐断线期间新建的群聊或单聊。
      refreshConversationsInBackground();
    },
    onPresenceChanged: (userId, online) => {
      setUsers((current) =>
        current.map((item) => (item.id === userId ? { ...item, online } : item)),
      );
      setConversations((current) =>
        current.map((item) => {
          if (!item.members.some((member) => member.id === userId)) return item;
          const members = item.members.map((member) =>
            member.id === userId ? { ...member, online } : member,
          );
          return {
            ...item,
            members,
            peer: item.peer?.id === userId ? { ...item.peer, online } : item.peer,
            onlineMemberCount: members.filter((member) => member.online).length,
          };
        }),
      );
    },
    onUsersChanged: (changedUserId) => {
      const refreshCurrentUser =
        changedUserId === user.id
          ? api.me().then((result) => {
              onUserUpdated(result.user);
              return result.user;
            })
          : Promise.resolve(null);
      void Promise.all([refreshUsers(), refreshConversations(), refreshCurrentUser])
        .then(([refreshedUsers, , refreshedCurrentUser]) => {
          const changedUser =
            refreshedCurrentUser ?? refreshedUsers.find((item) => item.id === changedUserId);
          if (!changedUser) return;
          setMessages((current) =>
            current.map((message) =>
              message.senderId === changedUserId
                ? {
                    ...message,
                    senderName: changedUser.displayName,
                    senderAvatarColor: changedUser.avatarColor,
                    senderAvatarUrl: changedUser.avatarUrl,
                  }
                : message,
            ),
          );
        })
        .catch((error) => {
          notify(errorMessage(error, "用户资料同步失败"), "error");
        });
    },
    onMessageCreated: (incoming) => {
      if (incoming.senderId === user.id) {
        confirmedClientMessageIdsRef.current.add(incoming.clientMessageId);
      }
      setOutbox((current) => {
        const queued = current[incoming.conversationId];
        if (!queued?.some((message) => message.clientMessageId === incoming.clientMessageId)) {
          return current;
        }
        const next = { ...current };
        const remaining = queued.filter(
          (message) => message.clientMessageId !== incoming.clientMessageId,
        );
        if (remaining.length > 0) next[incoming.conversationId] = remaining;
        else delete next[incoming.conversationId];
        return next;
      });

      const isCurrentConversation = incoming.conversationId === selectedIdRef.current;
      const isActivelyReading = isCurrentConversation && document.visibilityState === "visible";
      if (isCurrentConversation) {
        const scroll = messageScrollRef.current;
        const closeToBottom =
          !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
        if (closeToBottom || incoming.senderId === user.id) {
          scrollActionRef.current = { type: "bottom" };
        }
        setMessages((current) => upsertServerMessage(current, incoming));
        if (incoming.senderId !== user.id && isActivelyReading) {
          void api.markRead(incoming.conversationId, incoming.id).catch((error) => {
            notify(errorMessage(error, "已读状态同步失败"), "error");
          });
        }
      }

      if (incoming.senderId !== user.id && !isActivelyReading) {
        const preferences = notificationPreferencesRef.current;
        if (preferences.sound) void playMessageSound().catch(() => undefined);
        if (preferences.desktop) {
          const conversation = conversationsRef.current.find(
            (item) => item.id === incoming.conversationId,
          );
          const title =
            conversation?.type === "GROUP"
              ? `${incoming.senderName} · ${conversation.title}`
              : incoming.senderName;
          const body = messageSummary(incoming);

          if (window.nearChatDesktop) {
            void window.nearChatDesktop
              .showNotification({
                title,
                body,
                conversationId: incoming.conversationId,
              })
              .catch(() => undefined);
          } else if ("Notification" in window && Notification.permission === "granted") {
            try {
              const notification = new Notification(title, {
                body,
                tag: `near-chat:${incoming.conversationId}`,
              });
              notification.onclick = () => {
                window.focus();
                setSelectedId(incoming.conversationId);
                notification.close();
              };
            } catch {
              // 浏览器或操作系统可能临时拒绝通知，不能影响实时消息主流程。
            }
          }
        }
      }
      refreshConversationsInBackground();
    },
    onMessageUpdated: (incoming) => {
      if (incoming.conversationId === selectedIdRef.current) {
        setMessages((current) => applyMessageUpdate(current, incoming));
      }
      setOutbox((current) => {
        let changed = false;
        const next = Object.fromEntries(
          Object.entries(current).map(([conversationId, queued]) => {
            const updated = applyMessageUpdate(queued, incoming);
            if (updated.some((message, index) => message !== queued[index])) changed = true;
            return [conversationId, updated];
          }),
        );
        return changed ? next : current;
      });
      if (incoming.recalledAt) {
        setReplyTargets((current) => {
          const next = { ...current };
          let changed = false;
          for (const [conversationId, target] of Object.entries(next)) {
            if (target.id === incoming.id) {
              delete next[conversationId];
              changed = true;
            }
          }
          return changed ? next : current;
        });
      }
      refreshConversationsInBackground();
    },
    onUnreadChanged: (conversationId, unreadCount) => {
      setConversations((current) =>
        current.map((item) => (item.id === conversationId ? { ...item, unreadCount } : item)),
      );
    },
    onConversationChanged: (conversationId) => {
      void refreshConversations()
        .then((nextConversations) => {
          // 成员变化会改变历史消息的回执分母；仍在群内时同步刷新时间线。
          if (
            selectedIdRef.current === conversationId &&
            nextConversations.some((item) => item.id === conversationId)
          ) {
            setMessageLoadVersion((current) => current + 1);
          }
        })
        .catch((error) => notify(errorMessage(error, "会话刷新失败"), "error"));
    },
    onReceiptChanged: (receipts) => {
      if (receipts.length === 0) return;
      const receiptByMessageId = new Map(
        receipts.map((receipt) => [receipt.messageId, receipt.receipt]),
      );
      setMessages((current) =>
        current.map((message) => {
          const receipt = receiptByMessageId.get(message.id);
          return receipt ? { ...message, receipt } : message;
        }),
      );
    },
    onNudgeReceived: (nudge) => {
      setIncomingNudge(nudge);
      const preferences = notificationPreferencesRef.current;
      if (preferences.sound) void playMessageSound().catch(() => undefined);
      if (document.visibilityState === "visible" || !preferences.desktop) return;

      const body = `${nudge.senderName} 敲了敲你`;
      if (window.nearChatDesktop) {
        void window.nearChatDesktop
          .showNotification({
            title: "近聊提醒",
            body,
            conversationId: nudge.conversationId,
          })
          .catch(() => undefined);
      } else if ("Notification" in window && Notification.permission === "granted") {
        try {
          const notification = new Notification("近聊提醒", {
            body,
            tag: `near-chat:nudge:${nudge.senderId}`,
          });
          notification.onclick = () => {
            window.focus();
            setSelectedId(nudge.conversationId);
            notification.close();
          };
        } catch {
          // 原生提醒失败时，页面内的敲一下提示仍然可见。
        }
      }
    },
  });

  const updateDraft = (value: string) => {
    if (!selectedId) return;
    setDrafts((current) => {
      const next = { ...current };
      if (value) next[selectedId] = value;
      else delete next[selectedId];
      return next;
    });
  };

  const openDirect = async (peerId: string) => {
    try {
      const result = await api.directConversation(peerId);
      await refreshConversations();
      messageTargetRef.current = null;
      setHighlightedMessageId(null);
      setSelectedId(result.conversationId);
      setSidebarMode("recent");
    } catch (error) {
      notify(errorMessage(error, "会话创建失败"), "error");
    }
  };

  const nudgePeer = async () => {
    const conversation = selectedConversation;
    const peer = conversation?.type === "DIRECT" ? conversation.peer : null;
    if (!conversation || !peer) return;
    if (connection !== "connected") {
      notify("实时连接恢复后才能敲一下", "info");
      return;
    }
    if (!peer.online) {
      notify(`${peer.displayName} 当前不在线，可以直接给他留言`, "info");
      return;
    }

    setNudgingConversationId(conversation.id);
    try {
      await api.nudgeConversation(conversation.id);
      notify(`已敲了敲 ${peer.displayName}`, "success");
    } catch (error) {
      notify(errorMessage(error, "敲一下失败，请稍后重试"), "error");
    } finally {
      setNudgingConversationId((current) => (current === conversation.id ? null : current));
    }
  };

  const createGroup = async (name: string, memberIds: string[], expiresAt?: string) => {
    const result = await api.createGroup(name, memberIds, expiresAt);
    await refreshConversations();
    messageTargetRef.current = null;
    setHighlightedMessageId(null);
    setSelectedId(result.conversationId);
    setSidebarMode("recent");
    setShowCreateGroup(false);
    notify(expiresAt ? `闪聊“${name}”已开启` : `群聊“${name}”已创建`, "success");
  };

  const chooseFile = async (file: File | undefined) => {
    const targetConversationId = selectedId;
    if (!file || !targetConversationId) return;
    if (selectedFlashExpired) {
      notify("闪聊已经结束，只能查看历史消息", "info");
      return;
    }
    if (contactDeliveryInFlightRef.current) {
      notify("头像投递完成后即可继续选择附件", "info");
      return;
    }
    if (pendingAttachments[targetConversationId]) {
      notify("请先发送或移除当前待发送附件", "info");
      return;
    }
    if (uploadState) {
      notify("当前已有文件正在上传", "info");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      notify("单个文件不能超过 50 MB", "error");
      return;
    }

    setUploadState({ conversationId: targetConversationId, name: file.name, progress: 0 });
    try {
      const attachment = await api.upload(file, (progress) =>
        setUploadState((current) =>
          current?.conversationId === targetConversationId ? { ...current, progress } : current,
        ),
      );
      setPendingAttachments((current) => ({
        ...current,
        [targetConversationId]: attachment,
      }));
    } catch (error) {
      notify(errorMessage(error, "文件上传失败"), "error");
    } finally {
      setUploadState((current) =>
        current?.conversationId === targetConversationId ? null : current,
      );
    }
  };

  const removePendingAttachment = async () => {
    if (!pendingAttachment || !selectedId) return;
    const attachment = pendingAttachment;
    const conversationId = selectedId;
    setPendingAttachments((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    try {
      await api.deleteFile(attachment.id);
    } catch (error) {
      notify(errorMessage(error, "附件清理失败"), "error");
    }
  };

  const removeOutboxMessage = (conversationId: string, clientMessageId: string) => {
    setOutbox((current) => {
      const queued = current[conversationId] ?? [];
      const remaining = queued.filter((message) => message.clientMessageId !== clientMessageId);
      if (remaining.length === queued.length) return current;
      const next = { ...current };
      if (remaining.length > 0) next[conversationId] = remaining;
      else delete next[conversationId];
      return next;
    });
  };

  const deliverOutboxMessage = async (message: Message): Promise<boolean> => {
    const conversationId = message.conversationId;
    setOutbox((current) => ({
      ...current,
      [conversationId]: (current[conversationId] ?? []).map((queued) =>
        queued.clientMessageId === message.clientMessageId
          ? { ...queued, deliveryState: "SENDING", sendError: undefined }
          : queued,
      ),
    }));
    try {
      const result = await api.sendMessage(conversationId, {
        clientMessageId: message.clientMessageId,
        text: message.textContent ?? undefined,
        attachmentIds: message.attachments.map((attachment) => attachment.id),
        replyToMessageId: message.replyTo?.id,
      });
      confirmedClientMessageIdsRef.current.add(message.clientMessageId);
      removeOutboxMessage(conversationId, message.clientMessageId);
      if (selectedIdRef.current === conversationId) {
        scrollActionRef.current = { type: "bottom" };
        setMessages((current) => upsertServerMessage(current, result.message));
      }
      refreshConversationsInBackground();
      return true;
    } catch (error) {
      // WebSocket 可能先于 HTTP 响应确认消息；此时不能把已送达消息误标为失败。
      if (confirmedClientMessageIdsRef.current.has(message.clientMessageId)) {
        removeOutboxMessage(conversationId, message.clientMessageId);
        return true;
      }
      const failure = errorMessage(error, "发送失败，请重试");
      setOutbox((current) => ({
        ...current,
        [conversationId]: (current[conversationId] ?? []).map((queued) =>
          queued.clientMessageId === message.clientMessageId
            ? { ...queued, deliveryState: "FAILED", sendError: failure }
            : queued,
        ),
      }));
      notify("消息发送失败，可在消息下方重试", "error");
      return false;
    }
  };

  /**
   * 所有发送入口都先进入同一待发送队列。编辑器、头像投递以及后续桌面快捷发送
   * 因而共享幂等键、乐观消息、失败重试和附件清理语义。
   */
  const enqueueOutgoingMessage = (
    conversationId: string,
    input: { text?: string; attachment?: Attachment | null; replyTarget?: Message | null },
  ): Promise<boolean> => {
    const clientMessageId = createClientMessageId();
    const createdAt = new Date().toISOString();
    const normalizedText = input.text?.trim() ?? "";
    const attachment = input.attachment ?? null;
    const type = messageKindFromContentType(attachment?.contentType ?? null);
    const optimisticMessage: Message = {
      id: `local-${clientMessageId}`,
      conversationId,
      senderId: user.id,
      senderName: user.displayName,
      senderAvatarColor: user.avatarColor,
      senderAvatarUrl: user.avatarUrl,
      clientMessageId,
      type,
      textContent: normalizedText || null,
      createdAt,
      recalledAt: null,
      recallableUntil: new Date(Date.now() + 120_000).toISOString(),
      replyTo: input.replyTarget ? toMessageReply(input.replyTarget) : null,
      attachments: attachment ? [attachment] : [],
      receipt: { recipientCount: 0, deliveredCount: 0, readCount: 0 },
      deliveryState: "SENDING",
    };

    setOutbox((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? []), optimisticMessage],
    }));
    if (selectedIdRef.current === conversationId) scrollActionRef.current = { type: "bottom" };
    return deliverOutboxMessage(optimisticMessage);
  };

  const send = () => {
    if (!selectedId || sending || (!text.trim() && !pendingAttachment)) return;
    if (selectedFlashExpired) {
      notify("闪聊已经结束，只能查看历史消息", "info");
      return;
    }
    const conversationId = selectedId;
    void enqueueOutgoingMessage(conversationId, {
      text,
      attachment: pendingAttachment,
      replyTarget: replyingTo,
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setPendingAttachments((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setReplyTargets((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  };

  const sendVoicePostcard = async (file: File, _durationSeconds: number): Promise<boolean> => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || selectedFlashExpired || uploadState) {
      notify(
        selectedFlashExpired ? "闪聊已经结束，只能查看历史消息" : "当前已有文件正在上传",
        "info",
      );
      return false;
    }

    let attachment: Attachment | null = null;
    let queued = false;
    setUploadState({ conversationId, name: file.name, progress: 0 });
    try {
      attachment = await api.upload(file, (progress) =>
        setUploadState((current) =>
          current?.conversationId === conversationId ? { ...current, progress } : current,
        ),
      );
      queued = true;
      const delivered = await enqueueOutgoingMessage(conversationId, { attachment });
      if (delivered) notify("语音明信片已送出", "success");
      // 已进入统一待发送队列后即关闭录音弹窗；弱网失败由消息卡片负责重试，
      // 避免用户再次点击发送而生成两条相同语音。
      return true;
    } catch (error) {
      if (attachment && !queued) await api.deleteFile(attachment.id).catch(() => undefined);
      notify(errorMessage(error, "语音发送失败"), "error");
      return false;
    } finally {
      setUploadState((current) => (current?.conversationId === conversationId ? null : current));
    }
  };

  /**
   * 头像投递是“松手即发送”的快捷入口：先解析或复用单聊，再沿用标准上传与
   * 待发送队列。它不占用编辑器草稿，也不会把投递附件留成编辑器待发送项。
   */
  const deliverToContact = async (
    peerId: string,
    payload: ContactDropPayload,
  ): Promise<boolean> => {
    if (contactDeliveryInFlightRef.current || uploadState) {
      notify("当前已有文件或头像投递正在处理", "info");
      return false;
    }

    const peer = users.find((candidate) => candidate.id === peerId);
    if (!peer) {
      notify("联系人已不可用，请刷新后重试", "error");
      return false;
    }

    const file = payload.kind === "files" ? payload.files[0] : null;
    if (payload.kind === "files" && payload.files.length !== 1) {
      notify("一次只能投递一个图片或文件", "info");
      return false;
    }
    if (file && file.size > MAX_FILE_BYTES) {
      notify("单个文件不能超过 50 MB", "error");
      return false;
    }
    if (payload.kind === "text" && payload.text.length > 5_000) {
      notify("投递文本不能超过 5000 个字符", "error");
      return false;
    }

    contactDeliveryInFlightRef.current = true;
    setContactDelivery({
      peerId,
      label: file?.name ?? "文字消息",
      progress: file ? 0 : null,
    });

    let attachment: Attachment | null = null;
    let queued = false;
    let targetConversationId: string | null = null;
    try {
      const direct = await api.directConversation(peerId);
      targetConversationId = direct.conversationId;
      await refreshConversations();
      messageTargetRef.current = null;
      setHighlightedMessageId(null);
      selectedIdRef.current = direct.conversationId;
      setSelectedId(direct.conversationId);
      setSidebarMode("recent");

      if (file) {
        setUploadState({
          conversationId: direct.conversationId,
          name: file.name,
          progress: 0,
        });
        attachment = await api.upload(file, (progress) => {
          setUploadState((current) =>
            current?.conversationId === direct.conversationId ? { ...current, progress } : current,
          );
          setContactDelivery((current) =>
            current?.peerId === peerId ? { ...current, progress } : current,
          );
        });
      }

      queued = true;
      const delivered = await enqueueOutgoingMessage(direct.conversationId, {
        text: payload.kind === "text" ? payload.text : undefined,
        attachment,
      });
      if (delivered) notify(`已投递给 ${peer.displayName}`, "success");
      return delivered;
    } catch (error) {
      // 只有尚未进入待发送队列的附件才能在这里安全删除；队列中的失败消息仍可重试。
      if (attachment && !queued) await api.deleteFile(attachment.id).catch(() => undefined);
      notify(errorMessage(error, `向 ${peer.displayName} 投递失败`), "error");
      return false;
    } finally {
      contactDeliveryInFlightRef.current = false;
      setContactDelivery(null);
      if (targetConversationId) {
        setUploadState((current) =>
          current?.conversationId === targetConversationId ? null : current,
        );
      }
    }
  };

  const sendClipboardRelay = async (
    peerId: string,
    kind: ClipboardRelayContentKind,
  ): Promise<boolean> => {
    const payload = clipboardRelayPayload;
    if (!payload) return false;

    let contactPayload: ContactDropPayload;
    if (kind === "text") {
      if (!payload.text) return false;
      contactPayload = { kind: "text", text: payload.text };
    } else {
      try {
        contactPayload = { kind: "files", files: [await clipboardImageFile(payload)] };
      } catch (error) {
        notify(errorMessage(error, "剪贴板图片读取失败"), "error");
        return false;
      }
    }

    const delivered = await deliverToContact(peerId, contactPayload);
    if (delivered) {
      setClipboardRelayPayload((current) => (current?.id === payload.id ? null : current));
    }
    return delivered;
  };

  /**
   * 圈图回复先把浏览器生成的新 PNG 上传为独立附件，再引用原消息进入统一待发送
   * 队列。上传失败时删除孤立附件；进入队列后则保留附件以支持用户原地重试。
   */
  const sendAnnotatedImage = async (sourceMessage: Message, file: File): Promise<boolean> => {
    if (uploadState) {
      notify("当前已有文件正在上传，请稍后再发送圈图", "info");
      return false;
    }
    if (file.size > MAX_FILE_BYTES) {
      notify("标注图片不能超过 50 MB", "error");
      return false;
    }

    const conversationId = sourceMessage.conversationId;
    setUploadState({ conversationId, name: file.name, progress: 0 });
    let attachment: Attachment | null = null;
    let queued = false;
    try {
      attachment = await api.upload(file, (progress) =>
        setUploadState((current) =>
          current?.conversationId === conversationId ? { ...current, progress } : current,
        ),
      );
      queued = true;
      const delivered = await enqueueOutgoingMessage(conversationId, {
        attachment,
        replyTarget: sourceMessage,
      });
      if (delivered) notify("圈图回复已发送", "success");
      return true;
    } catch (error) {
      if (attachment && !queued) await api.deleteFile(attachment.id).catch(() => undefined);
      notify(errorMessage(error, "圈图回复上传失败"), "error");
      return false;
    } finally {
      setUploadState((current) => (current?.conversationId === conversationId ? null : current));
    }
  };

  const retryMessage = (message: Message) => {
    if (message.deliveryState !== "FAILED") return;
    void deliverOutboxMessage(message);
  };

  const discardMessage = (message: Message) => {
    removeOutboxMessage(message.conversationId, message.clientMessageId);
    void Promise.allSettled(
      message.attachments.map((attachment) => api.deleteFile(attachment.id)),
    ).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        notify("未发送附件将在后台自动清理", "info");
      }
    });
  };

  const copyMessage = async (message: Message) => {
    if (!message.textContent) return;
    try {
      await navigator.clipboard.writeText(message.textContent);
      notify("消息文本已复制", "success");
    } catch {
      notify("复制失败，请检查浏览器剪贴板权限", "error");
    }
  };

  const toggleMessageFavorite = async (message: Message) => {
    if (message.deliveryState || message.recalledAt || favoriteBusyMessageIds.has(message.id))
      return;
    setFavoriteBusyMessageIds((current) => new Set(current).add(message.id));
    try {
      const favoriteId = favoriteByMessageId[message.id];
      if (favoriteId) {
        await api.deleteFavorite(favoriteId);
        setFavoriteByMessageId((current) => {
          const next = { ...current };
          delete next[message.id];
          return next;
        });
        notify("已取消收藏", "success");
      } else {
        const result = await api.favoriteMessage(message.id);
        if (result.favorite.sourceMessageId) {
          setFavoriteByMessageId((current) => ({
            ...current,
            [result.favorite.sourceMessageId!]: result.favorite.id,
          }));
        }
        notify("已保存到我的收藏", "success");
      }
    } catch (error) {
      notify(errorMessage(error, "收藏操作失败"), "error");
    } finally {
      setFavoriteBusyMessageIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
  };

  const forgetFavorite = (favorite: MessageFavorite) => {
    if (!favorite.sourceMessageId) return;
    setFavoriteByMessageId((current) => {
      if (current[favorite.sourceMessageId!] !== favorite.id) return current;
      const next = { ...current };
      delete next[favorite.sourceMessageId!];
      return next;
    });
  };

  const beginMessageSelection = (message: Message) => {
    if (message.deliveryState || message.recalledAt) return;
    setMessageSelectionMode(true);
    setSelectedMessageIds(new Set([message.id]));
  };

  const toggleMessageSelection = (message: Message) => {
    if (message.deliveryState || message.recalledAt) return;
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(message.id)) {
        next.delete(message.id);
      } else if (next.size < MAX_FORWARD_MESSAGES) {
        next.add(message.id);
      } else {
        notify(`一次最多选择 ${MAX_FORWARD_MESSAGES} 条消息`, "info");
      }
      return next;
    });
  };

  const cancelMessageSelection = () => {
    setShowForwardDialog(false);
    setMessageSelectionMode(false);
    setSelectedMessageIds(new Set());
  };

  const selectAllVisibleMessages = () => {
    setSelectedMessageIds(
      new Set(selectableMessages.slice(-MAX_FORWARD_MESSAGES).map((message) => message.id)),
    );
  };

  const forwardSelectedMessages = async (targetConversationId: string): Promise<boolean> => {
    const selected = selectedMessages;
    if (selected.length === 0) return false;
    try {
      const result = await api.forwardMessages(
        targetConversationId,
        selected.map((message) => ({
          sourceMessageId: message.id,
          clientMessageId: createClientMessageId(),
        })),
      );
      if (selectedIdRef.current === targetConversationId) {
        scrollActionRef.current = { type: "bottom" };
        setMessages((current) => result.messages.reduce(upsertServerMessage, current));
      }
      refreshConversationsInBackground();
      notify(`已转发 ${selected.length} 条消息`, "success");
      cancelMessageSelection();
      return true;
    } catch (error) {
      notify(errorMessage(error, "批量转发失败"), "error");
      return false;
    }
  };

  const recallMessage = async (message: Message) => {
    try {
      const result = await api.recallMessage(message.conversationId, message.id);
      setMessages((current) => applyMessageUpdate(current, result.message));
      setReplyTargets((current) => {
        const next = { ...current };
        for (const [conversationId, target] of Object.entries(next)) {
          if (target.id === message.id) delete next[conversationId];
        }
        return next;
      });
      refreshConversationsInBackground();
      notify("消息已撤回", "success");
    } catch (error) {
      notify(errorMessage(error, "消息撤回失败"), "error");
    }
  };

  const toggleMessageReaction = async (
    message: Message,
    emoji: MessageReactionEmoji,
  ): Promise<boolean> => {
    try {
      const result = await api.toggleMessageReaction(message.conversationId, message.id, emoji);
      if (selectedIdRef.current === message.conversationId) {
        setMessages((current) => applyMessageUpdate(current, result.message));
      }
      return result.active;
    } catch (error) {
      notify(errorMessage(error, "消息反应同步失败"), "error");
      return false;
    }
  };

  const jumpToMessage = (messageId: string) => {
    const element = document.getElementById(`message-${messageId}`);
    if (element) {
      setHighlightedMessageId(messageId);
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!selectedId) return;
    messageTargetRef.current = { conversationId: selectedId, messageId };
    setMessageLoadVersion((current) => current + 1);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (messageSelectionMode || selectedFlashExpired || !event.dataTransfer.types.includes("Files"))
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFile(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingFile(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    if (messageSelectionMode) return;
    void chooseFile(event.dataTransfer.files[0]);
  };

  const logout = async () => {
    try {
      await Promise.allSettled(
        [
          ...Object.values(pendingAttachments),
          ...Object.values(outbox)
            .flat()
            .flatMap((message) => message.attachments),
        ].map((attachment) => api.deleteFile(attachment.id)),
      );
      await api.logout();
    } finally {
      onLogout();
    }
  };

  return (
    <main className={`app-frame ${selectedConversation ? "has-selection" : ""}`}>
      <ChatSidebar
        currentUser={user}
        users={users}
        conversations={conversations}
        selectedId={selectedId}
        drafts={drafts}
        pendingAttachments={pendingAttachments}
        loading={sidebarLoading}
        connection={connection}
        theme={theme}
        mode={sidebarMode}
        contactDelivery={contactDelivery}
        contactDropBusy={Boolean(contactDelivery) || Boolean(uploadState)}
        onThemeChange={onThemeChange}
        onModeChange={setSidebarMode}
        onSelectConversation={(conversationId) => {
          messageTargetRef.current = null;
          setHighlightedMessageId(null);
          setSelectedId(conversationId);
        }}
        onOpenDirect={(peerId) => void openDirect(peerId)}
        onDropToContact={(peerId, payload) => void deliverToContact(peerId, payload)}
        onCreateGroup={() => setShowCreateGroup(true)}
        onOpenMessageAssets={() => setShowMessageAssets(true)}
        onOpenTeamRadar={() => setShowTeamRadar(true)}
        onOpenProfile={() => setShowProfile(true)}
        onOpenAdmin={() => setShowAdmin(true)}
        onLogout={() => void logout()}
      />

      {incomingNudge && (
        <NudgeNotice
          key={incomingNudge.id}
          nudge={incomingNudge}
          currentConversationId={selectedId}
          onOpen={(conversationId) => {
            messageTargetRef.current = null;
            setHighlightedMessageId(null);
            selectedIdRef.current = conversationId;
            setSelectedId(conversationId);
            setSidebarMode("recent");
            setIncomingNudge(null);
          }}
          onDismiss={() => setIncomingNudge(null)}
        />
      )}

      {clipboardRelayPayload && (
        <ClipboardRelayDialog
          key={clipboardRelayPayload.id}
          payload={clipboardRelayPayload}
          users={clipboardRelayUsers}
          onSend={sendClipboardRelay}
          onDismiss={() => setClipboardRelayPayload(null)}
        />
      )}

      <section
        className={`chat-surface ${draggingFile ? "is-dragging-file" : ""} ${incomingNudge ? "has-incoming-nudge" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {selectedConversation ? (
          <>
            <header className="chat-header">
              <button
                className="mobile-back"
                type="button"
                onClick={() => {
                  messageTargetRef.current = null;
                  setHighlightedMessageId(null);
                  setSelectedId(null);
                }}
                aria-label="返回会话列表"
              >
                <ChevronLeft size={21} />
              </button>
              <Avatar
                name={selectedConversation.title}
                color={selectedConversation.avatarColor}
                src={selectedConversation.avatarUrl}
                size="small"
                online={
                  selectedConversation.type === "DIRECT"
                    ? selectedConversation.peer?.online
                    : undefined
                }
              />
              <div className="chat-title">
                <strong>{selectedConversation.title}</strong>
                {selectedConversation.expiresAt ? (
                  <FlashRoomBadge expiresAt={selectedConversation.expiresAt} />
                ) : selectedConversation.type === "DIRECT" && selectedConversation.peer?.status ? (
                  <UserStatusBubble status={selectedConversation.peer.status} />
                ) : (
                  <span>
                    {selectedConversation.type === "GROUP"
                      ? `${selectedConversation.onlineMemberCount} 人在线 · 共 ${selectedConversation.memberCount} 位成员`
                      : selectedConversation.peer?.online
                        ? "在线 · 可以即时收到消息"
                        : "离线 · 消息将在下次登录时送达"}
                  </span>
                )}
              </div>
              <ThemeToggle
                compact
                theme={theme}
                onChange={onThemeChange}
                className="mobile-theme-toggle"
              />
              {selectedConversation.type === "DIRECT" && selectedConversation.peer && (
                <button
                  type="button"
                  className={`header-search-button nudge-trigger ${nudgingConversationId === selectedConversation.id ? "is-knocking" : ""} ${!selectedConversation.peer.online ? "is-unavailable" : ""}`}
                  onClick={() => void nudgePeer()}
                  disabled={nudgingConversationId === selectedConversation.id}
                  aria-label={`敲一下 ${selectedConversation.peer.displayName}`}
                  title={
                    selectedConversation.peer.online
                      ? `敲一下 ${selectedConversation.peer.displayName}`
                      : `${selectedConversation.peer.displayName} 当前不在线`
                  }
                >
                  <Hand size={16} />
                  <span>敲一下</span>
                </button>
              )}
              <button
                type="button"
                className="header-search-button"
                onClick={() => setShowMessageSearch(true)}
                aria-label="搜索消息"
                title="搜索消息"
              >
                <Search size={17} />
              </button>
              {selectedConversation.type === "GROUP" && (
                <button
                  type="button"
                  className="header-search-button"
                  onClick={() => setShowGroupManagement(true)}
                  aria-label="打开群聊设置"
                  title="群聊设置"
                >
                  <Settings2 size={17} />
                </button>
              )}
              <div className={`connection-pill ${connection}`}>
                <i />
                {connection === "connected"
                  ? "局域网已连接"
                  : connection === "connecting"
                    ? "正在连接"
                    : "等待重连"}
              </div>
            </header>

            <div
              className="message-scroll"
              ref={messageScrollRef}
              onScroll={(event) => {
                if (event.currentTarget.scrollTop < 120) void loadOlderMessages();
              }}
            >
              <MessageTimeline
                conversation={selectedConversation}
                messages={displayMessages}
                currentUserId={user.id}
                loading={loadingMessages}
                loadingOlder={loadingOlder}
                hasMore={hasMoreMessages}
                endRef={endRef}
                highlightedMessageId={highlightedMessageId}
                favoriteMessageIds={favoriteMessageIds}
                favoriteBusyMessageIds={favoriteBusyMessageIds}
                selectionMode={messageSelectionMode}
                selectedMessageIds={selectedMessageIds}
                onLoadOlder={() => void loadOlderMessages()}
                onReply={(message) => {
                  if (!selectedId) return;
                  setReplyTargets((current) => ({ ...current, [selectedId]: message }));
                }}
                onAnnotateImage={(message, _attachment, file) => sendAnnotatedImage(message, file)}
                onCopy={(message) => void copyMessage(message)}
                onToggleFavorite={(message) => void toggleMessageFavorite(message)}
                onBeginSelection={beginMessageSelection}
                onToggleSelection={toggleMessageSelection}
                onReact={toggleMessageReaction}
                onRecall={(message) => void recallMessage(message)}
                onRetry={retryMessage}
                onDiscard={discardMessage}
                onJumpToMessage={jumpToMessage}
              />
            </div>

            {messageSelectionMode ? (
              <MessageSelectionToolbar
                selectedCount={selectedMessages.length}
                selectableCount={selectableMessages.length}
                maxSelection={MAX_FORWARD_MESSAGES}
                onSelectAll={selectAllVisibleMessages}
                onForward={() => setShowForwardDialog(true)}
                onCancel={cancelMessageSelection}
              />
            ) : (
              <MessageComposer
                key={selectedConversation.id}
                peerName={selectedConversation.title}
                text={text}
                pendingAttachment={pendingAttachment}
                upload={activeUpload}
                uploadBlocked={Boolean(uploadState)}
                sending={sending}
                disabled={selectedFlashExpired}
                disabledReason="房间已转为只读，历史消息和附件仍可查看。"
                replyingTo={replyingTo}
                onTextChange={updateDraft}
                onChooseFile={(file) => void chooseFile(file)}
                onRemoveAttachment={() => void removePendingAttachment()}
                onSendVoice={sendVoicePostcard}
                onSend={send}
                onCancelReply={() => {
                  if (!selectedId) return;
                  setReplyTargets((current) => {
                    const next = { ...current };
                    delete next[selectedId];
                    return next;
                  });
                }}
              />
            )}
          </>
        ) : (
          <div className="welcome-empty">
            <div className="welcome-orbit">
              <span>
                <MessageCircleMore size={28} />
              </span>
              <i />
              <i />
              <i />
            </div>
            <span className="welcome-eyebrow">NEARBY CONVERSATIONS</span>
            <h2>从一声招呼开始</h2>
            <p>选择已有会话，或者在联系人中找到身边的人。</p>
            <button type="button" onClick={() => setSidebarMode("people")}>
              <UsersRound size={16} />
              浏览联系人
            </button>
          </div>
        )}

        {draggingFile && (
          <div className="drop-overlay" aria-hidden="true">
            <span>
              <Paperclip size={26} />
            </span>
            <strong>松开即可添加附件</strong>
            <small>文件不会自动发送，你仍可以添加说明</small>
          </div>
        )}
      </section>

      {showAdmin && (
        <AdminPanel currentUser={user} onClose={() => setShowAdmin(false)} onNotify={notify} />
      )}
      {showProfile && (
        <ProfileDialog
          user={user}
          onClose={() => setShowProfile(false)}
          onUpdated={(updatedUser) => {
            onUserUpdated(updatedUser);
            void Promise.all([refreshUsers(), refreshConversations()]).catch((error) => {
              notify(errorMessage(error, "用户资料同步失败"), "error");
            });
          }}
          onPasswordChanged={onLogout}
          notificationPreferences={notificationPreferences}
          onNotificationPreferencesChanged={setNotificationPreferences}
        />
      )}
      {showCreateGroup && (
        <CreateGroupDialog
          users={users}
          onClose={() => setShowCreateGroup(false)}
          onCreate={createGroup}
        />
      )}
      {showMessageSearch && (
        <MessageSearchPanel
          conversations={conversations}
          selectedConversationId={selectedId}
          onClose={() => setShowMessageSearch(false)}
          onOpenResult={(conversationId, messageId) => {
            messageTargetRef.current = { conversationId, messageId };
            setSelectedId(conversationId);
            setMessageLoadVersion((current) => current + 1);
            setSidebarMode("recent");
            setShowMessageSearch(false);
          }}
        />
      )}
      {showMessageAssets && (
        <MessageAssetsDialog
          conversations={conversations}
          onClose={() => setShowMessageAssets(false)}
          onOpenMessage={(conversationId, messageId) => {
            messageTargetRef.current = { conversationId, messageId };
            setHighlightedMessageId(null);
            setSelectedId(conversationId);
            setMessageLoadVersion((current) => current + 1);
            setSidebarMode("recent");
            setShowMessageAssets(false);
          }}
          onFavoriteRemoved={forgetFavorite}
        />
      )}
      {showForwardDialog && selectedMessages.length > 0 && (
        <ForwardMessagesDialog
          conversations={conversations}
          messages={selectedMessages}
          onClose={() => setShowForwardDialog(false)}
          onForward={forwardSelectedMessages}
        />
      )}
      {showTeamRadar && (
        <TeamRadarDialog
          conversations={conversations}
          currentUserId={user.id}
          onClose={() => setShowTeamRadar(false)}
          onOpenConversation={(conversationId) => {
            messageTargetRef.current = null;
            setHighlightedMessageId(null);
            setSelectedId(conversationId);
            setSidebarMode("recent");
          }}
        />
      )}
      {showGroupManagement && selectedConversation?.type === "GROUP" && (
        <GroupManagementDialog
          conversation={selectedConversation}
          currentUser={user}
          users={users}
          onClose={() => setShowGroupManagement(false)}
          onChanged={async () => {
            await Promise.all([refreshUsers(), refreshConversations()]);
          }}
          onExited={() => {
            setShowGroupManagement(false);
            setSelectedId(null);
            setMessages([]);
            refreshConversationsInBackground();
          }}
        />
      )}
      {showNotificationPrompt && (
        <NotificationPermissionPrompt
          busy={requestingNotificationPermission}
          message={notificationPermissionMessage}
          onEnable={() => void enableDesktopNotifications()}
          onDismiss={dismissNotificationPrompt}
        />
      )}
      {toast && (
        <div
          className={`toast toast-${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
          key={toast.id}
        >
          {toast.tone === "success" ? (
            <CheckCircle2 size={18} />
          ) : toast.tone === "error" ? (
            <AlertCircle size={18} />
          ) : (
            <Info size={18} />
          )}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
    </main>
  );
}
