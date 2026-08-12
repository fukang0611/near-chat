import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
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
import type { Attachment, Conversation, Message, User } from "../types";
import { errorMessage } from "../utils/errors";
import { messageSummary, toMessageReply } from "../utils/message";
import {
  loadNotificationPreferences,
  type NotificationPreferences,
  playMessageSound,
  saveNotificationPreferences,
} from "../utils/notifications";
import type { ThemeMode } from "../utils/theme";
import { AdminPanel } from "./AdminPanel";
import { Avatar } from "./Avatar";
import { ChatSidebar, type SidebarMode } from "./ChatSidebar";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { GroupManagementDialog } from "./GroupManagementDialog";
import { MessageComposer } from "./MessageComposer";
import { MessageSearchPanel } from "./MessageSearchPanel";
import { MessageTimeline } from "./MessageTimeline";
import { ProfileDialog } from "./ProfileDialog";
import { ThemeToggle } from "./ThemeToggle";

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

  // 草稿与待发送附件按会话隔离，切换会话时保留各自上下文。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, Attachment>>({});
  const [replyTargets, setReplyTargets] = useState<Record<string, Message>>({});
  const [outbox, setOutbox] = useState<Record<string, Message[]>>({});
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(
    () => loadNotificationPreferences(user.id),
  );

  const [showAdmin, setShowAdmin] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupManagement, setShowGroupManagement] = useState(false);
  const [showMessageSearch, setShowMessageSearch] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const notificationPreferencesRef = useRef(notificationPreferences);
  const confirmedClientMessageIdsRef = useRef(new Set<string>());
  const scrollActionRef = useRef<
    { type: "bottom" } | { type: "preserve"; previousHeight: number; previousTop: number } | null
  >(null);
  const messageTargetRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const initializedConversationsRef = useRef(false);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedId) ?? null,
    [conversations, selectedId],
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
  const sending = selectedOutbox.some((message) => message.deliveryState === "SENDING");
  const activeUpload = uploadState?.conversationId === selectedId ? uploadState : null;

  useEffect(() => {
    if (showGroupManagement && selectedConversation?.type !== "GROUP") {
      setShowGroupManagement(false);
    }
  }, [selectedConversation?.type, showGroupManagement]);

  const notify = useCallback((message: string, tone: NoticeTone = "error") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

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
    if (!highlightedMessageId) return;
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
  }, [highlightedMessageId]);

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
          ? api.me().then((result) => onUserUpdated(result.user))
          : Promise.resolve();
      void Promise.all([refreshUsers(), refreshConversations(), refreshCurrentUser]).catch(
        (error) => {
          notify(errorMessage(error, "用户资料同步失败"), "error");
        },
      );
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
        if (
          preferences.desktop &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          const conversation = conversationsRef.current.find(
            (item) => item.id === incoming.conversationId,
          );
          try {
            const notification = new Notification(
              conversation?.type === "GROUP"
                ? `${incoming.senderName} · ${conversation.title}`
                : incoming.senderName,
              {
                body: messageSummary(incoming),
                tag: `near-chat:${incoming.conversationId}`,
              },
            );
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

  const createGroup = async (name: string, memberIds: string[]) => {
    const result = await api.createGroup(name, memberIds);
    await refreshConversations();
    messageTargetRef.current = null;
    setHighlightedMessageId(null);
    setSelectedId(result.conversationId);
    setSidebarMode("recent");
    setShowCreateGroup(false);
    notify(`群聊“${name}”已创建`, "success");
  };

  const chooseFile = async (file: File | undefined) => {
    const targetConversationId = selectedId;
    if (!file || !targetConversationId) return;
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

  const deliverOutboxMessage = async (message: Message) => {
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
    } catch (error) {
      // WebSocket 可能先于 HTTP 响应确认消息；此时不能把已送达消息误标为失败。
      if (confirmedClientMessageIdsRef.current.has(message.clientMessageId)) {
        removeOutboxMessage(conversationId, message.clientMessageId);
        return;
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
    }
  };

  const send = () => {
    if (!selectedId || sending || (!text.trim() && !pendingAttachment)) return;
    const conversationId = selectedId;
    const clientMessageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const type = pendingAttachment
      ? pendingAttachment.contentType.startsWith("image/")
        ? "IMAGE"
        : "FILE"
      : "TEXT";
    const optimisticMessage: Message = {
      id: `local-${clientMessageId}`,
      conversationId,
      senderId: user.id,
      senderName: user.displayName,
      senderAvatarColor: user.avatarColor,
      clientMessageId,
      type,
      textContent: text.trim() || null,
      createdAt,
      recalledAt: null,
      recallableUntil: new Date(Date.now() + 120_000).toISOString(),
      replyTo: replyingTo ? toMessageReply(replyingTo) : null,
      attachments: pendingAttachment ? [pendingAttachment] : [],
      receipt: { recipientCount: 0, deliveredCount: 0, readCount: 0 },
      deliveryState: "SENDING",
    };

    setOutbox((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? []), optimisticMessage],
    }));
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
    scrollActionRef.current = { type: "bottom" };
    void deliverOutboxMessage(optimisticMessage);
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
    if (!event.dataTransfer.types.includes("Files")) return;
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
        onThemeChange={onThemeChange}
        onModeChange={setSidebarMode}
        onSelectConversation={(conversationId) => {
          messageTargetRef.current = null;
          setHighlightedMessageId(null);
          setSelectedId(conversationId);
        }}
        onOpenDirect={(peerId) => void openDirect(peerId)}
        onCreateGroup={() => setShowCreateGroup(true)}
        onOpenProfile={() => setShowProfile(true)}
        onOpenAdmin={() => setShowAdmin(true)}
        onLogout={() => void logout()}
      />

      <section
        className={`chat-surface ${draggingFile ? "is-dragging-file" : ""}`}
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
                size="small"
                online={
                  selectedConversation.type === "DIRECT"
                    ? selectedConversation.peer?.online
                    : undefined
                }
              />
              <div className="chat-title">
                <strong>{selectedConversation.title}</strong>
                <span>
                  {selectedConversation.type === "GROUP"
                    ? `${selectedConversation.onlineMemberCount} 人在线 · 共 ${selectedConversation.memberCount} 位成员`
                    : selectedConversation.peer?.online
                      ? "在线 · 可以即时收到消息"
                      : "离线 · 消息将在下次登录时送达"}
                </span>
              </div>
              <ThemeToggle
                compact
                theme={theme}
                onChange={onThemeChange}
                className="mobile-theme-toggle"
              />
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
                onLoadOlder={() => void loadOlderMessages()}
                onReply={(message) => {
                  if (!selectedId) return;
                  setReplyTargets((current) => ({ ...current, [selectedId]: message }));
                }}
                onCopy={(message) => void copyMessage(message)}
                onRecall={(message) => void recallMessage(message)}
                onRetry={retryMessage}
                onDiscard={discardMessage}
                onJumpToMessage={jumpToMessage}
              />
            </div>

            <MessageComposer
              peerName={selectedConversation.title}
              text={text}
              pendingAttachment={pendingAttachment}
              upload={activeUpload}
              uploadBlocked={Boolean(uploadState)}
              sending={sending}
              replyingTo={replyingTo}
              onTextChange={updateDraft}
              onChooseFile={(file) => void chooseFile(file)}
              onRemoveAttachment={() => void removePendingAttachment()}
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
