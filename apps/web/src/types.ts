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

export interface ForwardedMessageSource {
  senderName: string;
  conversationTitle: string;
  createdAt: string;
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
  /** 旧消息没有该字段；非空时展示转发来源，不影响正文与附件类型。 */
  forwardedFrom?: ForwardedMessageSource | null;
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

export type AiRuntimeStatus =
  "DISABLED" | "CONFIGURATION_REQUIRED" | "STARTING" | "READY" | "UNAVAILABLE";

/** 服务端只返回能力与模型名称，不向浏览器暴露密钥和模型服务地址。 */
export interface AiCapabilities {
  enabled: boolean;
  status: AiRuntimeStatus;
  reason: string;
  features: {
    knowledgeManagement: boolean;
    knowledgeIndexing: boolean;
    knowledgeSearch: boolean;
    knowledgeAnswer: boolean;
    personalAssistants: boolean;
    messageActions: boolean;
  };
  provider: {
    chatModel: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number;
  };
}

export interface AdminAiModel {
  id: string;
  name: string;
  baseUrl: string;
  providerModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  isDefault: boolean;
  updatedAt: string;
}

/** 只有管理员可以读取服务地址；所有角色都只能看到密钥是否已配置。 */
export interface AdminAiSettings {
  enabled: boolean;
  defaultChatModelId: string | null;
  models: AdminAiModel[];
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  revision: number;
  updatedAt: string;
}

export interface AiModelChoice {
  id: string;
  name: string;
  providerModel: string;
  isDefault: boolean;
}

export interface UserAiModels {
  models: AiModelChoice[];
  selectedModelId: string | null;
  defaultModelId: string | null;
}

export type MessageAiAction = "SUMMARIZE" | "EXTRACT_TASKS" | "REWRITE" | "TRANSLATE" | "ANALYZE";

export type MessageAiTargetLanguage = "CHINESE" | "ENGLISH";

export interface MessageAiActionResult {
  action: MessageAiAction;
  targetLanguage: MessageAiTargetLanguage | null;
  result: string;
  model: AiModelChoice;
  source: {
    messageId: string;
    senderName: string;
    conversationTitle: string;
    textPreview: string;
    attachments: Array<Attachment & { processed: boolean }>;
    truncated: boolean;
  };
  generatedAt: string;
}

export type KnowledgeBaseAccessRole = "OWNER" | "EDITOR" | "VIEWER";
export type KnowledgeBaseMemberRole = Exclude<KnowledgeBaseAccessRole, "OWNER">;

export type KnowledgeBaseUser = Pick<
  User,
  "id" | "username" | "displayName" | "avatarColor" | "avatarUrl"
>;

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  owner: KnowledgeBaseUser;
  accessRole: KnowledgeBaseAccessRole;
  memberCount: number;
  documentCount: number;
  readyDocumentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseMember {
  user: KnowledgeBaseUser;
  role: KnowledgeBaseMemberRole;
  addedAt: string;
}

export interface KnowledgeBaseMemberDirectory {
  owner: KnowledgeBaseUser;
  members: KnowledgeBaseMember[];
  candidates: KnowledgeBaseUser[];
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  attachment: Attachment;
  status: "QUEUED" | "INDEXING" | "READY" | "FAILED";
  chunkCount: number;
  errorMessage: string | null;
  extraction: KnowledgeExtractionDetails | null;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeExtractionMethod =
  "TEXT" | "MARKDOWN" | "HTML" | "JSON" | "PDF_TEXT" | "DOCX" | "SPREADSHEET" | "OCR";

export interface KnowledgeExtractionDetails {
  method: KnowledgeExtractionMethod;
  pageCount?: number;
  processedPages?: number;
  averageConfidence?: number | null;
  truncated?: boolean;
  worksheetCount?: number;
  rowCount?: number;
  cellCount?: number;
}

export interface KnowledgeSource {
  chunkId: string;
  score: number;
  excerpt: string;
  position: number;
  document: {
    id: string;
    name: string;
    attachment: Attachment;
  };
}

export interface KnowledgeSearchResult {
  mode: "HYBRID" | "KEYWORD";
  sources: KnowledgeSource[];
}

export interface KnowledgeAnswer {
  answer: string;
  sources: KnowledgeSource[];
  generatedAt: string;
}

export type AiAssistantCategory = "GENERAL" | "WRITING" | "ANALYSIS" | "PLANNING";

export interface AiAssistant {
  id: string;
  name: string;
  description: string;
  category: AiAssistantCategory;
  instructions: string;
  avatarColor: string;
  modelId: string | null;
  model: Pick<AiModelChoice, "id" | "name" | "providerModel"> | null;
  knowledgeBaseIds: string[];
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAssistantMessage {
  id: string;
  assistantId: string;
  threadId: string;
  role: "USER" | "ASSISTANT";
  content: string;
  model: Pick<AiModelChoice, "id" | "name" | "providerModel"> | null;
  sources: KnowledgeSource[];
  /** 用户在这一轮明确交给助理读取的工作区文件。 */
  referencedFiles?: AiAssistantFile[];
  /** 用户把该条助理回复显式保存后生成的文件。 */
  generatedFiles?: AiAssistantFile[];
  createdAt: string;
}

export interface AiAssistantThread {
  id: string;
  assistantId: string;
  title: string;
  archived: boolean;
  isDefault: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AiAssistantFileOrigin = "CHAT" | "UPLOAD" | "GENERATED";

export interface AiAssistantFile {
  id: string;
  assistantId: string;
  origin: AiAssistantFileOrigin;
  sourceMessageId: string | null;
  attachment: Attachment;
  /** 当前版本仅向模型发送可在服务端提取文字的文档。 */
  processable: boolean;
  createdAt: string;
}

export type AiAssistantTaskSchedule = "ONCE" | "DAILY" | "WEEKLY";
export type AiAssistantTaskStatus = "NEVER" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type AiAssistantTaskBrowserAction = "NONE" | "READ" | "SCREENSHOT";

export interface AiAssistantTaskToolSummary {
  files?: {
    ids?: string[];
    count?: number;
    status?: "AUTHORIZED" | "REQUESTED" | "USED" | "NOT_USED" | "FAILED_OR_ABORTED";
  };
  browser?: {
    action?: AiAssistantTaskBrowserAction;
    url?: string | null;
    status?: "AUTHORIZED" | "REQUESTED" | "SUCCEEDED" | "NOT_USED" | "FAILED";
    runId?: string | null;
    artifactFileId?: string | null;
    pageTitle?: string;
    error?: string;
  };
}

export interface AiAssistantTaskRun {
  id: string;
  taskId: string;
  trigger: "SCHEDULED" | "MANUAL";
  status: Exclude<AiAssistantTaskStatus, "NEVER">;
  scheduledFor: string;
  startedAt: string;
  completedAt: string | null;
  resultMessageId: string | null;
  browserRunId: string | null;
  toolSummary: AiAssistantTaskToolSummary;
  errorMessage: string | null;
}

export interface AiAssistantTask {
  id: string;
  assistantId: string;
  threadId: string;
  title: string;
  prompt: string;
  scheduleType: AiAssistantTaskSchedule;
  fileIds: string[];
  browserAction: AiAssistantTaskBrowserAction;
  browserUrl: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  runRequested: boolean;
  lastRunAt: string | null;
  lastStatus: AiAssistantTaskStatus;
  lastError: string | null;
  runCount: number;
  recentRuns: AiAssistantTaskRun[];
  createdAt: string;
  updatedAt: string;
}

/** 助理后台任务完成后通过 WebSocket 送达，仅包含展示与定位所需的信息。 */
export interface AiAssistantTaskEvent {
  taskId: string;
  assistantId: string;
  threadId: string;
  assistantName: string;
  taskTitle: string;
  status: "SUCCEEDED" | "FAILED";
  messageId: string | null;
  preview: string;
  createdAt: string;
}

export interface AiAssistantBrowserPermission {
  assistantId: string;
  enabled: boolean;
  /** 页面读取是启用工具后的基础权限，保留字段便于未来扩展策略。 */
  allowRead: true;
  allowScreenshot: boolean;
  allowInteraction: boolean;
  updatedAt: string | null;
}

export type AiAssistantBrowserAction = "OPEN" | "READ" | "SCREENSHOT" | "CLICK" | "FILL";
export type AiAssistantBrowserRunStatus =
  "AWAITING_CONFIRMATION" | "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type AiAssistantBrowserStepStatus =
  "AWAITING_CONFIRMATION" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AiAssistantBrowserElement {
  ref: string;
  kind: "LINK" | "BUTTON" | "INPUT" | "TEXTAREA" | "SELECT" | "EDITABLE";
  label: string;
  inputType: string | null;
  href: string | null;
  disabled: boolean;
}

export interface AiAssistantBrowserStep {
  id: string;
  runId: string;
  sequence: number;
  action: AiAssistantBrowserAction;
  status: AiAssistantBrowserStepStatus;
  /** FILL 仅包含元素名称与字符数，不包含用户填写的实际内容。 */
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifact: {
    assistantFileId: string;
    attachment: Attachment;
  } | null;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AiAssistantBrowserRun {
  id: string;
  assistantId: string;
  goal: string;
  startUrl: string;
  status: AiAssistantBrowserRunStatus;
  currentUrl: string | null;
  pageTitle: string | null;
  pageExcerpt: string | null;
  pageElements: AiAssistantBrowserElement[];
  openedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  steps: AiAssistantBrowserStep[];
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

/** 收藏使用消息快照；sourceAvailable 仅控制是否还能跳回原会话。 */
export interface MessageFavorite {
  id: string;
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  sourceConversationTitle: string;
  sourceSenderId: string | null;
  sourceSenderName: string;
  sourceSenderAvatarColor: string;
  sourceSenderAvatarUrl: string | null;
  type: MessageKind;
  textContent: string | null;
  forwardedFrom?: ForwardedMessageSource | null;
  messageCreatedAt: string;
  createdAt: string;
  attachments: Attachment[];
  sourceAvailable: boolean;
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
