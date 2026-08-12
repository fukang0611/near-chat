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
  peer: User;
  lastMessage: {
    type: "TEXT" | "IMAGE" | "FILE";
    text: string | null;
    createdAt: string | null;
  } | null;
  unreadCount: number;
}

export interface Attachment {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
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
  attachments: Attachment[];
}

export interface AdminUser extends User {
  role: "ADMIN" | "USER";
  enabled: boolean;
  online: boolean;
  createdAt?: string;
}
