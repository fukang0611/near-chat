import type {
  AssistantRetrievalGrants,
  CreateMemoryInput,
  MemoryCandidate,
  MemoryCandidatePage,
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemorySettings,
  MemoryTier,
  UpdateMemoryInput,
} from "@near-chat/contracts";
import type {
  AdminUser,
  AdminAiSettings,
  AiAssistant,
  AiAssistantBrowserAction,
  AiAssistantBrowserPermission,
  AiAssistantBrowserRun,
  AiAssistantCategory,
  AiAssistantFile,
  AiAssistantMessage,
  AiAssistantReminder,
  AiAssistantTask,
  AiAssistantTaskSchedule,
  AiAssistantThread,
  AiCapabilities,
  Attachment,
  AuditLog,
  ChatFileCategory,
  ChatFilePage,
  Conversation,
  FileQuota,
  Message,
  MessageAiAction,
  MessageAiActionResult,
  MessageAiTargetLanguage,
  MessageFavorite,
  MessagePage,
  KnowledgeAnswer,
  KnowledgeBase,
  KnowledgeBaseMemberDirectory,
  KnowledgeBaseMemberRole,
  KnowledgeDocument,
  KnowledgeSearchResult,
  TeamRadar,
  User,
  UserAiModels,
} from "./types";

const TOKEN_KEY = "near-chat-token";

export interface SendMessageInput {
  clientMessageId: string;
  text?: string;
  attachmentIds?: string[];
  replyToMessageId?: string;
}

export interface ForwardMessageInput {
  sourceMessageId: string;
  clientMessageId: string;
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

export interface UpdateAiSettingsInput {
  enabled: boolean;
  defaultChatModelId: string | null;
  embeddingBaseUrl: string | null;
  embeddingApiKey?: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
}

export interface SaveAiModelInput {
  name: string;
  baseUrl: string | null;
  apiKey?: string | null;
  providerModel: string;
  enabled: boolean;
}

export interface SaveAiAssistantInput {
  name: string;
  description: string;
  category: AiAssistantCategory;
  instructions: string;
  avatarColor: string;
  modelId: string | null;
  knowledgeBaseIds: string[];
  toolGrants: AssistantRetrievalGrants;
}

export interface SaveAiAssistantTaskInput {
  threadId: string;
  title: string;
  prompt: string;
  scheduleType: AiAssistantTaskSchedule;
  scheduledFor: string;
  enabled: boolean;
  /** 只有这里显式选择的助理文件才会交给后台任务读取。 */
  fileIds: string[];
  /** 自动任务仅支持无副作用的页面读取和截图。 */
  browserAction: "NONE" | "READ" | "SCREENSHOT";
  browserUrl: string | null;
}

export interface SaveAiAssistantReminderInput {
  threadId: string;
  title: string;
  note: string;
  scheduledAt: string;
}

export interface AdminAiMutationResponse {
  settings: AdminAiSettings;
  capabilities: AiCapabilities;
  reindexQueued: number;
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
  teamRadar: (timezoneOffsetMinutes = new Date().getTimezoneOffset()) => {
    const query = new URLSearchParams({ timezoneOffsetMinutes: String(timezoneOffsetMinutes) });
    return request<TeamRadar>(`/api/team/radar?${query}`);
  },
  directConversation: (userId: string) =>
    request<{ conversationId: string }>(`/api/conversations/direct/${userId}`, {
      method: "POST",
    }),
  nudgeConversation: (conversationId: string) =>
    request<void>(`/api/conversations/${conversationId}/nudge`, { method: "POST" }),
  createGroup: (name: string, memberIds: string[], expiresAt?: string) =>
    request<{ conversationId: string }>("/api/conversations/groups", {
      method: "POST",
      body: JSON.stringify({ name, memberIds, expiresAt }),
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
  forwardMessages: (conversationId: string, items: ForwardMessageInput[]) =>
    request<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages/forward`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  recallMessage: (conversationId: string, messageId: string) =>
    request<{ message: Message }>(
      `/api/conversations/${conversationId}/messages/${messageId}/recall`,
      { method: "POST" },
    ),
  toggleMessageReaction: (conversationId: string, messageId: string, emoji: string) =>
    request<{ message: Message; active: boolean }>(
      `/api/conversations/${conversationId}/messages/${messageId}/reactions`,
      {
        method: "POST",
        body: JSON.stringify({ emoji }),
      },
    ),
  markRead: (conversationId: string, throughMessageId?: string) =>
    request<{ unreadCount: number }>(`/api/conversations/${conversationId}/read`, {
      method: "POST",
      body: JSON.stringify({ throughMessageId }),
    }),
  runMessageAiAction: (
    messageId: string,
    input: {
      action: MessageAiAction;
      targetLanguage?: MessageAiTargetLanguage;
      modelId?: string;
    },
  ) =>
    request<MessageAiActionResult>(`/api/messages/${messageId}/ai-actions`, {
      method: "POST",
      body: JSON.stringify(input),
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
  aiCapabilities: () => request<{ capabilities: AiCapabilities }>("/api/ai/capabilities"),
  aiModels: () => request<UserAiModels>("/api/ai/models"),
  selectAiModel: (modelId: string | null) =>
    request<UserAiModels>("/api/ai/preferences/model", {
      method: "PUT",
      body: JSON.stringify({ modelId }),
    }),
  aiAssistants: () => request<{ assistants: AiAssistant[] }>("/api/ai/assistants"),
  createAiAssistant: (input: SaveAiAssistantInput) =>
    request<{ assistant: AiAssistant }>("/api/ai/assistants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAiAssistant: (assistantId: string, input: Partial<SaveAiAssistantInput>) =>
    request<{ assistant: AiAssistant }>(`/api/ai/assistants/${assistantId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAiAssistant: (assistantId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}`, { method: "DELETE" }),
  aiAssistantThreads: (assistantId: string, includeArchived = false) =>
    request<{ threads: AiAssistantThread[] }>(
      `/api/ai/assistants/${assistantId}/threads?includeArchived=${includeArchived}`,
    ),
  createAiAssistantThread: (assistantId: string, title: string) =>
    request<{ thread: AiAssistantThread }>(`/api/ai/assistants/${assistantId}/threads`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  updateAiAssistantThread: (
    assistantId: string,
    threadId: string,
    input: { title?: string; archived?: boolean },
  ) =>
    request<{ thread: AiAssistantThread }>(
      `/api/ai/assistants/${assistantId}/threads/${threadId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  aiAssistantMessages: (assistantId: string, threadId: string) =>
    request<{ messages: AiAssistantMessage[] }>(
      `/api/ai/assistants/${assistantId}/threads/${threadId}/messages`,
    ),
  clearAiAssistantMessages: (assistantId: string, threadId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}/threads/${threadId}/messages`, {
      method: "DELETE",
    }),
  sendAiAssistantMessage: (
    assistantId: string,
    threadId: string,
    content: string,
    fileIds: string[] = [],
  ) =>
    request<{ messages: AiAssistantMessage[] }>(
      `/api/ai/assistants/${assistantId}/threads/${threadId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content, fileIds }),
      },
    ),
  aiAssistantMessageLocation: (assistantId: string, messageId: string) =>
    request<{ threadId: string }>(
      `/api/ai/assistants/${assistantId}/messages/${messageId}/location`,
    ),
  aiAssistantFiles: (assistantId: string) =>
    request<{ files: AiAssistantFile[] }>(`/api/ai/assistants/${assistantId}/files`),
  addAiAssistantFile: (assistantId: string, attachmentId: string, origin: "CHAT" | "UPLOAD") =>
    request<{ file: AiAssistantFile }>(`/api/ai/assistants/${assistantId}/files`, {
      method: "POST",
      body: JSON.stringify({ attachmentId, origin }),
    }),
  deleteAiAssistantFile: (assistantId: string, fileId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}/files/${fileId}`, { method: "DELETE" }),
  saveAiAssistantMessageFile: (
    assistantId: string,
    messageId: string,
    input: { format: "MARKDOWN" | "TEXT"; name?: string },
  ) =>
    request<{ file: AiAssistantFile }>(
      `/api/ai/assistants/${assistantId}/messages/${messageId}/file`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  aiAssistantTasks: (assistantId: string, threadId?: string) =>
    request<{ tasks: AiAssistantTask[] }>(
      `/api/ai/assistants/${assistantId}/tasks${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
    ),
  aiAssistantSchedule: (assistantId: string) =>
    request<{ tasks: AiAssistantTask[]; reminders: AiAssistantReminder[] }>(
      `/api/ai/assistants/${assistantId}/schedule`,
    ),
  createAiAssistantReminder: (assistantId: string, input: SaveAiAssistantReminderInput) =>
    request<{ reminder: AiAssistantReminder }>(`/api/ai/assistants/${assistantId}/reminders`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAiAssistantReminder: (
    assistantId: string,
    reminderId: string,
    input: Partial<Omit<SaveAiAssistantReminderInput, "threadId">> & { completed?: boolean },
  ) =>
    request<{ reminder: AiAssistantReminder }>(
      `/api/ai/assistants/${assistantId}/reminders/${reminderId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  deleteAiAssistantReminder: (assistantId: string, reminderId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}/reminders/${reminderId}`, {
      method: "DELETE",
    }),
  createAiAssistantTask: (assistantId: string, input: SaveAiAssistantTaskInput) =>
    request<{ task: AiAssistantTask }>(`/api/ai/assistants/${assistantId}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAiAssistantTask: (
    assistantId: string,
    taskId: string,
    input: Partial<SaveAiAssistantTaskInput>,
  ) =>
    request<{ task: AiAssistantTask }>(`/api/ai/assistants/${assistantId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAiAssistantTask: (assistantId: string, taskId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}/tasks/${taskId}`, { method: "DELETE" }),
  runAiAssistantTask: (assistantId: string, taskId: string) =>
    request<{ task: AiAssistantTask }>(`/api/ai/assistants/${assistantId}/tasks/${taskId}/run`, {
      method: "POST",
    }),
  aiAssistantBrowserPermission: (assistantId: string) =>
    request<{ permission: AiAssistantBrowserPermission }>(
      `/api/ai/assistants/${assistantId}/browser/permission`,
    ),
  updateAiAssistantBrowserPermission: (
    assistantId: string,
    input: { enabled: boolean; allowScreenshot: boolean; allowInteraction: boolean },
  ) =>
    request<{ permission: AiAssistantBrowserPermission }>(
      `/api/ai/assistants/${assistantId}/browser/permission`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  aiAssistantBrowserRuns: (assistantId: string) =>
    request<{ runs: AiAssistantBrowserRun[] }>(`/api/ai/assistants/${assistantId}/browser/runs`),
  createAiAssistantBrowserRun: (assistantId: string, goal: string, startUrl: string) =>
    request<{ run: AiAssistantBrowserRun }>(`/api/ai/assistants/${assistantId}/browser/runs`, {
      method: "POST",
      body: JSON.stringify({ goal, startUrl }),
    }),
  prepareAiAssistantBrowserStep: (
    assistantId: string,
    runId: string,
    input: { action: Exclude<AiAssistantBrowserAction, "OPEN">; elementRef?: string },
  ) =>
    request<{ run: AiAssistantBrowserRun }>(
      `/api/ai/assistants/${assistantId}/browser/runs/${runId}/steps`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  confirmAiAssistantBrowserStep: (
    assistantId: string,
    runId: string,
    stepId: string,
    value?: string,
  ) =>
    request<{ run: AiAssistantBrowserRun }>(
      `/api/ai/assistants/${assistantId}/browser/runs/${runId}/steps/${stepId}/confirm`,
      { method: "POST", body: JSON.stringify(value === undefined ? {} : { value }) },
    ),
  finishAiAssistantBrowserRun: (
    assistantId: string,
    runId: string,
    outcome: "SUCCEEDED" | "CANCELLED",
  ) =>
    request<{ run: AiAssistantBrowserRun }>(
      `/api/ai/assistants/${assistantId}/browser/runs/${runId}/finish`,
      { method: "POST", body: JSON.stringify({ outcome }) },
    ),
  deleteAiAssistantBrowserRun: (assistantId: string, runId: string) =>
    request<void>(`/api/ai/assistants/${assistantId}/browser/runs/${runId}`, {
      method: "DELETE",
    }),
  knowledgeBases: () => request<{ knowledgeBases: KnowledgeBase[] }>("/api/knowledge-bases"),
  createKnowledgeBase: (input: { name: string; description?: string }) =>
    request<{ knowledgeBase: KnowledgeBase }>("/api/knowledge-bases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateKnowledgeBase: (knowledgeBaseId: string, input: { name?: string; description?: string }) =>
    request<{ knowledgeBase: KnowledgeBase }>(`/api/knowledge-bases/${knowledgeBaseId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteKnowledgeBase: (knowledgeBaseId: string) =>
    request<void>(`/api/knowledge-bases/${knowledgeBaseId}`, { method: "DELETE" }),
  knowledgeBaseMembers: (knowledgeBaseId: string) =>
    request<KnowledgeBaseMemberDirectory>(`/api/knowledge-bases/${knowledgeBaseId}/members`),
  updateKnowledgeBaseMembers: (
    knowledgeBaseId: string,
    members: Array<{ userId: string; role: KnowledgeBaseMemberRole }>,
  ) =>
    request<KnowledgeBaseMemberDirectory>(`/api/knowledge-bases/${knowledgeBaseId}/members`, {
      method: "PUT",
      body: JSON.stringify({ members }),
    }),
  knowledgeDocuments: (knowledgeBaseId: string) =>
    request<{ documents: KnowledgeDocument[] }>(
      `/api/knowledge-bases/${knowledgeBaseId}/documents`,
    ),
  addKnowledgeDocument: (knowledgeBaseId: string, attachmentId: string) =>
    request<{ document: KnowledgeDocument }>(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
      method: "POST",
      body: JSON.stringify({ attachmentId }),
    }),
  reindexKnowledgeDocument: (knowledgeBaseId: string, documentId: string) =>
    request<{ queued: boolean }>(
      `/api/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/reindex`,
      { method: "POST" },
    ),
  deleteKnowledgeDocument: (knowledgeBaseId: string, documentId: string) =>
    request<void>(`/api/knowledge-bases/${knowledgeBaseId}/documents/${documentId}`, {
      method: "DELETE",
    }),
  searchKnowledge: (knowledgeBaseId: string, query: string, topK?: number) =>
    request<KnowledgeSearchResult>(`/api/knowledge-bases/${knowledgeBaseId}/search`, {
      method: "POST",
      body: JSON.stringify({ query, topK }),
    }),
  askKnowledge: (knowledgeBaseId: string, question: string, modelId?: string) =>
    request<KnowledgeAnswer>(`/api/knowledge-bases/${knowledgeBaseId}/ask`, {
      method: "POST",
      body: JSON.stringify({ question, modelId }),
    }),
  chatFiles: (
    options: {
      keyword?: string;
      category?: ChatFileCategory;
      conversationId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams({
      category: options.category ?? "ALL",
      limit: String(options.limit ?? 100),
      offset: String(options.offset ?? 0),
    });
    if (options.keyword) query.set("q", options.keyword);
    if (options.conversationId) query.set("conversationId", options.conversationId);
    return request<ChatFilePage>(`/api/message-assets/files?${query}`);
  },
  messageFavorites: () =>
    request<{ favorites: MessageFavorite[] }>("/api/message-assets/favorites"),
  favoriteMessage: (messageId: string) =>
    request<{ favorite: MessageFavorite; created: boolean }>(
      `/api/messages/${messageId}/favorite`,
      { method: "POST" },
    ),
  deleteFavorite: (favoriteId: string) =>
    request<void>(`/api/message-assets/favorites/${favoriteId}`, { method: "DELETE" }),
  memories: (
    options: {
      keyword?: string;
      kind?: MemoryKind;
      tier?: MemoryTier;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 100),
      offset: String(options.offset ?? 0),
    });
    if (options.keyword) query.set("q", options.keyword);
    if (options.kind) query.set("kind", options.kind);
    if (options.tier) query.set("tier", options.tier);
    return request<MemoryPage>(`/api/memories?${query}`);
  },
  createMemory: (input: CreateMemoryInput) =>
    request<{ memory: MemoryRecord }>("/api/memories", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMemory: (memoryId: string, input: UpdateMemoryInput) =>
    request<{ memory: MemoryRecord }>(`/api/memories/${memoryId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  forgetMemory: (memoryId: string) =>
    request<void>(`/api/memories/${memoryId}`, { method: "DELETE" }),
  memoryCandidates: () => request<MemoryCandidatePage>("/api/memory-candidates"),
  rememberMessage: (messageId: string) =>
    request<{ candidate: MemoryCandidate; created: boolean }>(
      `/api/messages/${messageId}/memory-candidate`,
      { method: "POST" },
    ),
  acceptMemoryCandidate: (candidateId: string, tier: MemoryTier) =>
    request<{ memory: MemoryRecord }>(`/api/memory-candidates/${candidateId}/accept`, {
      method: "POST",
      body: JSON.stringify({ tier }),
    }),
  rejectMemoryCandidate: (candidateId: string) =>
    request<void>(`/api/memory-candidates/${candidateId}`, { method: "DELETE" }),
  memorySettings: () => request<{ settings: MemorySettings }>("/api/memory-settings"),
  updateMemorySettings: (input: {
    explicitCaptureEnabled?: boolean;
    semanticCaptureEnabled?: boolean;
  }) =>
    request<{ settings: MemorySettings }>("/api/memory-settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
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
  adminAiSettings: () =>
    request<{ settings: AdminAiSettings; capabilities: AiCapabilities }>("/api/admin/ai-settings"),
  updateAdminAiSettings: (input: UpdateAiSettingsInput) =>
    request<AdminAiMutationResponse>("/api/admin/ai-settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  createAdminAiModel: (input: SaveAiModelInput) =>
    request<AdminAiMutationResponse>("/api/admin/ai-models", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAdminAiModel: (modelId: string, input: SaveAiModelInput) =>
    request<AdminAiMutationResponse>(`/api/admin/ai-models/${modelId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteAdminAiModel: (modelId: string) =>
    request<AdminAiMutationResponse>(`/api/admin/ai-models/${modelId}`, {
      method: "DELETE",
    }),
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
  updateStatus: (input: { text: string; emoji: string; expiresAt: string }) =>
    request<{ user: User }>("/api/auth/status", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  clearStatus: () => request<{ user: User }>("/api/auth/status", { method: "DELETE" }),
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
