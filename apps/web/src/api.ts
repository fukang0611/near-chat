import type {
  AdminUser,
  Attachment,
  AuditLog,
  Conversation,
  FileQuota,
  Message,
  MessagePage,
  User,
} from "./types";

const TOKEN_KEY = "near-chat-token";

export interface SendMessageInput {
  clientMessageId: string;
  text?: string;
  attachmentIds?: string[];
  replyToMessageId?: string;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  role: "ADMIN" | "USER";
}

export interface UpdateUserInput {
  enabled?: boolean;
  displayName?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let message = "请求失败，请稍后重试";
    try {
      const data = (await response.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // 网关或代理可能返回非 JSON 错误页，此时保留稳定的中文兜底文案。
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<{ user: User }>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  users: () => request<{ users: User[] }>("/api/users"),
  conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
  directConversation: (userId: string) =>
    request<{ conversationId: string }>(`/api/conversations/direct/${userId}`, {
      method: "POST",
    }),
  nudgeConversation: (conversationId: string) =>
    request<void>(`/api/conversations/${conversationId}/nudge`, { method: "POST" }),
  createGroup: (name: string, memberIds: string[]) =>
    request<{ conversationId: string }>("/api/conversations/groups", {
      method: "POST",
      body: JSON.stringify({ name, memberIds }),
    }),
  updateGroup: (conversationId: string, input: { name?: string; avatarColor?: string }) =>
    request<void>(`/api/conversations/${conversationId}/group`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  addGroupMembers: (conversationId: string, memberIds: string[]) =>
    request<{ addedIds: string[] }>(`/api/conversations/${conversationId}/members`, {
      method: "POST",
      body: JSON.stringify({ memberIds }),
    }),
  removeGroupMember: (conversationId: string, userId: string) =>
    request<void>(`/api/conversations/${conversationId}/members/${userId}`, {
      method: "DELETE",
    }),
  transferGroupOwner: (conversationId: string, userId: string) =>
    request<void>(`/api/conversations/${conversationId}/transfer-owner`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  leaveGroup: (conversationId: string) =>
    request<{ dissolved: boolean; nextOwnerId: string | null }>(
      `/api/conversations/${conversationId}/leave`,
      { method: "POST" },
    ),
  disbandGroup: (conversationId: string) =>
    request<void>(`/api/conversations/${conversationId}`, { method: "DELETE" }),
  messages: (
    conversationId: string,
    options: { around?: string; cursor?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.around) query.set("around", options.around);
    if (options.cursor) query.set("cursor", options.cursor);
    return request<MessagePage>(`/api/conversations/${conversationId}/messages?${query}`);
  },
  searchMessages: (keyword: string, conversationId?: string) => {
    const query = new URLSearchParams({ q: keyword, limit: "50" });
    if (conversationId) query.set("conversationId", conversationId);
    return request<{ messages: Message[] }>(`/api/messages/search?${query}`);
  },
  sendMessage: (conversationId: string, input: SendMessageInput) =>
    request<{ message: Message }>(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  recallMessage: (conversationId: string, messageId: string) =>
    request<{ message: Message }>(
      `/api/conversations/${conversationId}/messages/${messageId}/recall`,
      { method: "POST" },
    ),
  markRead: (conversationId: string, throughMessageId?: string) =>
    request<{ unreadCount: number }>(`/api/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ throughMessageId }),
    }),
  upload: (file: File, onProgress?: (progress: number) => void): Promise<Attachment> =>
    new Promise((resolve, reject) => {
      // fetch 暂不提供稳定的上传进度事件，因此仅上传路径使用 XMLHttpRequest。
      const form = new FormData();
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files");
      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          onProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        let data: { attachment?: Attachment; message?: string } = {};
        try {
          data = JSON.parse(xhr.responseText) as typeof data;
        } catch {
          // 非 JSON 响应继续走下方通用错误。
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.attachment) {
          onProgress?.(100);
          resolve(data.attachment);
          return;
        }
        reject(new ApiError(xhr.status, data.message ?? "文件上传失败"));
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "网络连接中断，文件上传失败")));
      xhr.send(form);
    }),
  deleteFile: (fileId: string) => request<void>(`/api/files/${fileId}`, { method: "DELETE" }),
  fileQuota: () => request<FileQuota>("/api/files/quota"),
  fileBlob: async (fileId: string, download = false): Promise<Blob> => {
    const token = getToken();
    const response = await fetch(`/api/files/${fileId}/content${download ? "?download=1" : ""}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new ApiError(response.status, "文件读取失败");
    return response.blob();
  },
  adminUsers: () => request<{ users: AdminUser[] }>("/api/admin/users"),
  auditLogs: () => request<{ logs: AuditLog[] }>("/api/admin/audit-logs?limit=100"),
  createUser: (input: CreateUserInput) =>
    request<{ user: AdminUser }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateUser: (userId: string, input: UpdateUserInput) =>
    request<{ user: AdminUser }>(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  resetPassword: (userId: string, password: string) =>
    request<void>(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  forceLogout: (userId: string) =>
    request<void>(`/api/admin/users/${userId}/force-logout`, { method: "POST" }),
  updateProfile: (input: { displayName?: string; avatarColor?: string }) =>
    request<{ user: User }>("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("avatar", file);
    return request<{ user: User }>("/api/auth/avatar", {
      method: "POST",
      body: form,
    });
  },
  deleteAvatar: () =>
    request<{ user: User }>("/api/auth/avatar", {
      method: "DELETE",
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

export function websocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws?token=${encodeURIComponent(getToken() ?? "")}`;
}
