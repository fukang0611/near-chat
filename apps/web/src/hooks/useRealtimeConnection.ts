import { useEffect, useRef, useState } from "react";
import { websocketUrl } from "../api";
import type {
  AiAssistantReminderEvent,
  AiAssistantTaskEvent,
  AiCapabilities,
  Message,
  NudgeEvent,
  ReceiptChange,
} from "../types";

export type ConnectionState = "connected" | "connecting" | "offline";

interface RealtimeHandlers {
  onSessionInvalid: () => void;
  onPresenceSnapshot: (onlineUserIds: string[]) => void;
  onPresenceChanged: (userId: string, online: boolean) => void;
  onUsersChanged: (userId: string) => void;
  onMessageCreated: (message: Message) => void;
  onMessageUpdated: (message: Message) => void;
  onUnreadChanged: (conversationId: string, unreadCount: number) => void;
  onConversationChanged: (conversationId: string) => void;
  onReceiptChanged: (receipts: ReceiptChange[]) => void;
  onNudgeReceived: (nudge: NudgeEvent) => void;
  onAssistantTaskCompleted?: (event: AiAssistantTaskEvent) => void;
  onAssistantReminderDue?: (event: AiAssistantReminderEvent) => void;
  onAiCapabilitiesChanged?: (capabilities: AiCapabilities) => void;
}

type RealtimeEvent =
  | { type: "presence.snapshot"; payload: { onlineUserIds: string[] } }
  | { type: "presence.changed"; payload: { userId: string; online: boolean } }
  | { type: "users.changed"; payload: { userId: string } }
  | { type: "message.created"; payload: { message: Message } }
  | { type: "message.updated"; payload: { message: Message } }
  | { type: "unread.changed"; payload: { conversationId: string; unreadCount: number } }
  | { type: "conversation.changed"; payload: { conversationId: string } }
  | { type: "receipt.changed"; payload: { receipts: ReceiptChange[] } }
  | { type: "ai.capabilities.changed"; payload: { capabilities: AiCapabilities } }
  | { type: "assistant.task.completed"; payload: { task: AiAssistantTaskEvent } }
  | { type: "assistant.reminder.due"; payload: { reminder: AiAssistantReminderEvent } }
  | { type: "nudge.received"; payload: { nudge: NudgeEvent } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.senderId === "string" &&
    typeof value.senderName === "string" &&
    typeof value.senderAvatarColor === "string" &&
    typeof value.clientMessageId === "string" &&
    (value.type === "TEXT" ||
      value.type === "IMAGE" ||
      value.type === "AUDIO" ||
      value.type === "FILE") &&
    (value.textContent === null || typeof value.textContent === "string") &&
    typeof value.createdAt === "string" &&
    (value.recalledAt === null || typeof value.recalledAt === "string") &&
    typeof value.recallableUntil === "string" &&
    (value.replyTo === null || isMessageReply(value.replyTo)) &&
    (value.forwardedFrom === undefined ||
      value.forwardedFrom === null ||
      isForwardedMessageSource(value.forwardedFrom)) &&
    Array.isArray(value.attachments) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) && value.reactions.every(isMessageReaction))) &&
    isReceiptSummary(value.receipt)
  );
}

function isForwardedMessageSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.senderName === "string" &&
    typeof value.conversationTitle === "string" &&
    typeof value.createdAt === "string"
  );
}

function isMessageReaction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.emoji === "string" &&
    typeof value.count === "number" &&
    Array.isArray(value.users) &&
    value.users.every(
      (user) =>
        isRecord(user) && typeof user.id === "string" && typeof user.displayName === "string",
    )
  );
}

function isMessageReply(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.senderId === "string" &&
    typeof value.senderName === "string" &&
    (value.type === "TEXT" ||
      value.type === "IMAGE" ||
      value.type === "AUDIO" ||
      value.type === "FILE") &&
    (value.textContent === null || typeof value.textContent === "string") &&
    (value.attachmentName === null || typeof value.attachmentName === "string") &&
    typeof value.recalled === "boolean"
  );
}

function isReceiptSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.recipientCount === "number" &&
    typeof value.deliveredCount === "number" &&
    typeof value.readCount === "number"
  );
}

function isReceiptChange(value: unknown): value is ReceiptChange {
  return (
    isRecord(value) &&
    typeof value.messageId === "string" &&
    typeof value.conversationId === "string" &&
    isReceiptSummary(value.receipt)
  );
}

function isNudgeEvent(value: unknown): value is NudgeEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.senderId === "string" &&
    typeof value.senderName === "string" &&
    typeof value.senderAvatarColor === "string" &&
    (value.senderAvatarUrl === null || typeof value.senderAvatarUrl === "string") &&
    typeof value.createdAt === "string"
  );
}

function isAssistantTaskEvent(value: unknown): value is AiAssistantTaskEvent {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.assistantId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.assistantName === "string" &&
    typeof value.taskTitle === "string" &&
    (value.status === "SUCCEEDED" || value.status === "FAILED") &&
    (value.messageId === null || typeof value.messageId === "string") &&
    typeof value.preview === "string" &&
    typeof value.createdAt === "string"
  );
}

function isAssistantReminderEvent(value: unknown): value is AiAssistantReminderEvent {
  return (
    isRecord(value) &&
    typeof value.reminderId === "string" &&
    typeof value.assistantId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.assistantName === "string" &&
    typeof value.title === "string" &&
    typeof value.note === "string" &&
    typeof value.scheduledAt === "string" &&
    typeof value.createdAt === "string"
  );
}

function isAiCapabilities(value: unknown): value is AiCapabilities {
  if (!isRecord(value) || !isRecord(value.features) || !isRecord(value.provider)) return false;
  return (
    typeof value.enabled === "boolean" &&
    (value.status === "DISABLED" ||
      value.status === "CONFIGURATION_REQUIRED" ||
      value.status === "STARTING" ||
      value.status === "READY" ||
      value.status === "UNAVAILABLE") &&
    typeof value.reason === "string" &&
    typeof value.features.knowledgeManagement === "boolean" &&
    typeof value.features.knowledgeIndexing === "boolean" &&
    typeof value.features.knowledgeSearch === "boolean" &&
    typeof value.features.knowledgeAnswer === "boolean" &&
    typeof value.features.personalAssistants === "boolean" &&
    typeof value.features.messageActions === "boolean" &&
    (value.provider.chatModel === null || typeof value.provider.chatModel === "string") &&
    (value.provider.embeddingModel === null || typeof value.provider.embeddingModel === "string") &&
    typeof value.provider.embeddingDimensions === "number"
  );
}

export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  try {
    const event = JSON.parse(raw) as { type?: unknown; payload?: unknown };
    if (typeof event.type !== "string" || !isRecord(event.payload)) return null;

    const payload = event.payload;
    switch (event.type) {
      case "presence.snapshot":
        return Array.isArray(payload.onlineUserIds) &&
          payload.onlineUserIds.every((id) => typeof id === "string")
          ? { type: event.type, payload: { onlineUserIds: payload.onlineUserIds } }
          : null;
      case "presence.changed":
        return typeof payload.userId === "string" && typeof payload.online === "boolean"
          ? {
              type: event.type,
              payload: { userId: payload.userId, online: payload.online },
            }
          : null;
      case "users.changed":
        return typeof payload.userId === "string"
          ? { type: event.type, payload: { userId: payload.userId } }
          : null;
      case "message.created":
      case "message.updated":
        return isMessage(payload.message)
          ? { type: event.type, payload: { message: payload.message } }
          : null;
      case "unread.changed":
        return typeof payload.conversationId === "string" && typeof payload.unreadCount === "number"
          ? {
              type: event.type,
              payload: {
                conversationId: payload.conversationId,
                unreadCount: payload.unreadCount,
              },
            }
          : null;
      case "conversation.changed":
        return typeof payload.conversationId === "string"
          ? { type: event.type, payload: { conversationId: payload.conversationId } }
          : null;
      case "receipt.changed":
        return Array.isArray(payload.receipts) && payload.receipts.every(isReceiptChange)
          ? { type: event.type, payload: { receipts: payload.receipts } }
          : null;
      case "ai.capabilities.changed":
        return isAiCapabilities(payload.capabilities)
          ? { type: event.type, payload: { capabilities: payload.capabilities } }
          : null;
      case "nudge.received":
        return isNudgeEvent(payload) ? { type: event.type, payload: { nudge: payload } } : null;
      case "assistant.task.completed":
        return isAssistantTaskEvent(payload)
          ? { type: event.type, payload: { task: payload } }
          : null;
      case "assistant.reminder.due":
        return isAssistantReminderEvent(payload)
          ? { type: event.type, payload: { reminder: payload } }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 管理 WebSocket 的完整生命周期：连接、事件分发、断线重连和令牌失效。
 * 调用方只处理领域事件，不需要了解定时器或 socket 状态机。
 */
export function useRealtimeConnection(handlers: RealtimeHandlers): ConnectionState {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (!active) return;
      setConnection("connecting");
      socket = new WebSocket(websocketUrl());

      socket.onopen = () => setConnection("connected");
      socket.onmessage = (messageEvent) => {
        const event = parseRealtimeEvent(messageEvent.data as string);
        if (!event) {
          console.warn("忽略无法解析的实时事件");
          return;
        }

        const current = handlersRef.current;
        switch (event.type) {
          case "presence.snapshot":
            current.onPresenceSnapshot(event.payload.onlineUserIds);
            break;
          case "presence.changed":
            current.onPresenceChanged(event.payload.userId, event.payload.online);
            break;
          case "users.changed":
            current.onUsersChanged(event.payload.userId);
            break;
          case "message.created":
            current.onMessageCreated(event.payload.message);
            break;
          case "message.updated":
            current.onMessageUpdated(event.payload.message);
            break;
          case "unread.changed":
            current.onUnreadChanged(event.payload.conversationId, event.payload.unreadCount);
            break;
          case "conversation.changed":
            current.onConversationChanged(event.payload.conversationId);
            break;
          case "receipt.changed":
            current.onReceiptChanged(event.payload.receipts);
            break;
          case "ai.capabilities.changed":
            current.onAiCapabilitiesChanged?.(event.payload.capabilities);
            break;
          case "nudge.received":
            current.onNudgeReceived(event.payload.nudge);
            break;
          case "assistant.task.completed":
            current.onAssistantTaskCompleted?.(event.payload.task);
            break;
          case "assistant.reminder.due":
            current.onAssistantReminderDue?.(event.payload.reminder);
            break;
        }
      };
      socket.onclose = (event) => {
        if (!active) return;
        // 4003 由服务端用于账号禁用或令牌版本失效，不应继续重连。
        if (event.code === 4003) {
          handlersRef.current.onSessionInvalid();
          return;
        }
        setConnection("offline");
        reconnectTimer = window.setTimeout(connect, 1_500);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return connection;
}
