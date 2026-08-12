import { useEffect, useRef, useState } from "react";
import { websocketUrl } from "../api";
import type { Message, ReceiptChange } from "../types";

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
}

type RealtimeEvent =
  | { type: "presence.snapshot"; payload: { onlineUserIds: string[] } }
  | { type: "presence.changed"; payload: { userId: string; online: boolean } }
  | { type: "users.changed"; payload: { userId: string } }
  | { type: "message.created"; payload: { message: Message } }
  | { type: "message.updated"; payload: { message: Message } }
  | { type: "unread.changed"; payload: { conversationId: string; unreadCount: number } }
  | { type: "conversation.changed"; payload: { conversationId: string } }
  | { type: "receipt.changed"; payload: { receipts: ReceiptChange[] } };

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
    (value.type === "TEXT" || value.type === "IMAGE" || value.type === "FILE") &&
    (value.textContent === null || typeof value.textContent === "string") &&
    typeof value.createdAt === "string" &&
    (value.recalledAt === null || typeof value.recalledAt === "string") &&
    typeof value.recallableUntil === "string" &&
    (value.replyTo === null || isMessageReply(value.replyTo)) &&
    Array.isArray(value.attachments) &&
    isReceiptSummary(value.receipt)
  );
}

function isMessageReply(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.senderId === "string" &&
    typeof value.senderName === "string" &&
    (value.type === "TEXT" || value.type === "IMAGE" || value.type === "FILE") &&
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

function parseRealtimeEvent(raw: string): RealtimeEvent | null {
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
