export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  online?: boolean;
  role?: "ADMIN" | "USER";
}

export interface Conversation {
  id: string;
  type: "DIRECT" | "GROUP";
  title: string;
  avatarColor: string;
  ownerId: string | null;
  peer: User | null;
  members: User[];
  memberCount: number;
  onlineMemberCount: number;
  lastMessage: {
    type: "TEXT" | "IMAGE" | "FILE";
    text: string | null;
    createdAt: string | null;
    senderId: string | null;
    senderName: string | null;
    recalled: boolean;
  } | null;
  unreadCount: number;
}

export interface Attachment {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
}

export interface MessageReply {
  id: string;
  senderId: string;
  senderName: string;
  type: "TEXT" | "IMAGE" | "FILE";
  textContent: string | null;
  attachmentName: string | null;
  recalled: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarColor: string;
  clientMessageId: string;
  type: "TEXT" | "IMAGE" | "FILE";
  textContent: string | null;
  createdAt: string;
  recalledAt: string | null;
  recallableUntil: string;
  replyTo: MessageReply | null;
  attachments: Attachment[];
  receipt: ReceiptSummary;
  /** 仅存在于客户端待发送队列，服务端消息不会携带该字段。 */
  deliveryState?: "SENDING" | "FAILED";
  sendError?: string;
}

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ReceiptSummary {
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
}

export interface ReceiptChange {
  messageId: string;
  conversationId: string;
  receipt: ReceiptSummary;
}

export interface AdminUser extends User {
  role: "ADMIN" | "USER";
  enabled: boolean;
  online: boolean;
  createdAt?: string;
}

export interface FileQuota {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

export interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  actor: Pick<User, "id" | "displayName" | "username"> | null;
}
