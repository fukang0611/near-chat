export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  status?: UserStatus | null;
  online?: boolean;
  role?: "ADMIN" | "USER";
}

export interface UserStatus {
  text: string;
  emoji: string;
  expiresAt: string;
}

export interface Conversation {
  id: string;
  type: "DIRECT" | "GROUP";
  title: string;
  avatarColor: string;
  avatarUrl: string | null;
  ownerId: string | null;
  /** 非空表示限时闪聊；到达该时间后会话保留但只读。 */
  expiresAt?: string | null;
  peer: User | null;
  members: User[];
  memberCount: number;
  onlineMemberCount: number;
  lastMessage: {
    type: MessageKind;
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

export type MessageKind = "TEXT" | "IMAGE" | "AUDIO" | "FILE";

export interface MessageReply {
  id: string;
  senderId: string;
  senderName: string;
  type: MessageKind;
  textContent: string | null;
  attachmentName: string | null;
  recalled: boolean;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  users: Array<{ id: string; displayName: string }>;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarColor: string;
  senderAvatarUrl: string | null;
  clientMessageId: string;
  type: MessageKind;
  textContent: string | null;
  createdAt: string;
  recalledAt: string | null;
  recallableUntil: string;
  replyTo: MessageReply | null;
  attachments: Attachment[];
  /** 旧版本缓存可能没有该字段，展示层按空数组兼容。 */
  reactions?: MessageReaction[];
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

export interface TeamRadarMember {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  status: UserStatus | null;
}

export interface TeamRadarMessageSignal {
  type: MessageKind;
  text: string | null;
  senderName: string;
}

export interface TeamRadar {
  generatedAt: string;
  dayStartedAt: string;
  totalMemberCount: number;
  onlineMembers: TeamRadarMember[];
  todayMessageCount: number;
  activeConversations: Array<{
    conversationId: string;
    messageCount: number;
    lastActivityAt: string;
    lastMessage: TeamRadarMessageSignal;
  }>;
  unreadConversations: Array<{
    conversationId: string;
    unreadCount: number;
    latestUnreadAt: string;
    lastMessage: TeamRadarMessageSignal;
  }>;
}

/** 不落库的实时轻提醒，只在接收方当前连接中短暂存在。 */
export interface NudgeEvent {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarColor: string;
  senderAvatarUrl: string | null;
  createdAt: string;
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

export type ChatFileCategory = "ALL" | "IMAGE" | "AUDIO" | "FILE";

/** 消息资产中心中的附件记录，同时携带原消息定位信息。 */
export interface ChatFileItem {
  attachment: Attachment;
  category: Exclude<ChatFileCategory, "ALL">;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  messageText: string | null;
  createdAt: string;
}

export interface ChatFilePage {
  files: ChatFileItem[];
  total: number;
  totalBytes: number;
  offset: number;
  hasMore: boolean;
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
