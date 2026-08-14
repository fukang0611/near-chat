import {
  ArchiveRestore,
  ArrowUp,
  BrainCircuit,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  FileText,
  Globe2,
  LibraryBig,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Plus,
  Save,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SaveAiAssistantInput } from "../api";
import type {
  AiAssistant,
  AiAssistantCategory,
  AiAssistantFile,
  AiAssistantMessage,
  AiAssistantThread,
  AiCapabilities,
  KnowledgeBase,
  KnowledgeSource,
  UserAiModels,
} from "../types";
import { errorMessage } from "../utils/errors";
import { AssistantBrowserPanel } from "./AssistantBrowserPanel";
import { AssistantFilesPanel } from "./AssistantFilesPanel";
import {
  ASSISTANT_CATEGORY_META,
  AssistantAvatar,
  assistantCategoryIcon,
} from "./AssistantIdentity";
import { AssistantTasksPanel } from "./AssistantTasksPanel";
import { AssistantThreadBar } from "./AssistantThreadBar";

export interface AssistantDirectorySnapshot {
  assistants: AiAssistant[];
  loading: boolean;
}

interface AssistantWorkspaceProps {
  capabilities: AiCapabilities;
  selectedId: string | null;
  onSelectedIdChange: (assistantId: string | null) => void;
  onDirectoryChange: (snapshot: AssistantDirectorySnapshot) => void;
  onMobileBack: () => void;
  initialMessageId?: string | null;
  initialThreadId?: string | null;
  refreshVersion?: number;
  createRequestVersion?: number;
}

interface AssistantPreset extends SaveAiAssistantInput {
  kicker: string;
}

const ASSISTANT_PRESETS: AssistantPreset[] = [
  {
    kicker: "日常协作",
    name: "随身助理",
    description: "整理想法、回答问题，并把复杂事情说清楚",
    category: "GENERAL",
    instructions: "理解我的真实目标，先给结论，再补充必要的步骤和注意事项。",
    avatarColor: "#6757E8",
    modelId: null,
    knowledgeBaseIds: [],
  },
  {
    kicker: "内容表达",
    name: "写作搭档",
    description: "起草、改写和润色团队内外的文字内容",
    category: "WRITING",
    instructions: "保持原意，语言自然克制；先确认受众和用途，再给出可直接使用的版本。",
    avatarColor: "#D9657C",
    modelId: null,
    knowledgeBaseIds: [],
  },
  {
    kicker: "信息洞察",
    name: "分析助手",
    description: "提炼资料、比较方案，区分事实与判断",
    category: "ANALYSIS",
    instructions: "先提炼关键信息，再分析原因和影响；明确标注假设、风险与待确认项。",
    avatarColor: "#2F9D83",
    modelId: null,
    knowledgeBaseIds: [],
  },
  {
    kicker: "行动规划",
    name: "计划管家",
    description: "拆解目标、安排优先级并定义完成标准",
    category: "PLANNING",
    instructions: "把目标拆成可执行步骤，说明顺序、依赖、负责人建议和清晰的完成标准。",
    avatarColor: "#D08742",
    modelId: null,
    knowledgeBaseIds: [],
  },
];

const AVATAR_COLORS = ["#6757E8", "#D9657C", "#2F9D83", "#D08742", "#3C83C8", "#8C62B5"];
const NOTICE_DISMISS_DELAY = {
  success: 3_000,
  error: 6_000,
} as const;

function SourceChip({ source, onOpen }: { source: KnowledgeSource; onOpen: () => void }) {
  return (
    <button className="assistant-source-chip" type="button" onClick={onOpen}>
      <FileText size={13} />
      <span>{source.document.name}</span>
      <small>片段 {source.position + 1}</small>
      <ChevronRight size={12} />
    </button>
  );
}

function AssistantMessageFileChip({
  file,
  onDownload,
}: {
  file: AiAssistantFile;
  onDownload: () => void;
}) {
  return (
    <button
      className="assistant-message-file-chip"
      type="button"
      onClick={onDownload}
      title={`下载 ${file.attachment.originalName}`}
    >
      <FileText size={14} />
      <span>{file.attachment.originalName}</span>
      <Download size={12} />
    </button>
  );
}

function emptyForm(preset = ASSISTANT_PRESETS[0]!): SaveAiAssistantInput {
  return {
    name: preset.name,
    description: preset.description,
    category: preset.category,
    instructions: preset.instructions,
    avatarColor: preset.avatarColor,
    modelId: null,
    knowledgeBaseIds: [],
  };
}

/**
 * 嵌入式私人助理工作台：NearChat 保存角色、模型选择、资料绑定和对话历史，Mastra
 * 只参与单次生成。自动任务使用 PostgreSQL 持久调度并把结果写回同一时间线。
 */
export function AssistantWorkspace({
  capabilities,
  selectedId,
  onSelectedIdChange,
  onDirectoryChange,
  onMobileBack,
  initialMessageId = null,
  initialThreadId = null,
  refreshVersion = 0,
  createRequestVersion = 0,
}: AssistantWorkspaceProps) {
  const [assistants, setAssistants] = useState<AiAssistant[]>([]);
  const [threads, setThreads] = useState<AiAssistantThread[]>([]);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Record<string, string>>({});
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const [threadBusyId, setThreadBusyId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiAssistantMessage[]>([]);
  const [models, setModels] = useState<UserAiModels>({
    models: [],
    selectedModelId: null,
    defaultModelId: null,
  });
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingText, setSendingText] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<"chat" | "tasks" | "files" | "browser">(
    "chat",
  );
  const [assistantFiles, setAssistantFiles] = useState<AiAssistantFile[]>([]);
  const [browserFocusRunId, setBrowserFocusRunId] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [sendingFiles, setSendingFiles] = useState<AiAssistantFile[]>([]);
  const [saveFileDraft, setSaveFileDraft] = useState<{
    messageId: string;
    name: string;
    format: "MARKDOWN" | "TEXT";
  } | null>(null);
  const [savingMessageFile, setSavingMessageFile] = useState(false);
  const [messageLoadVersion, setMessageLoadVersion] = useState(0);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(initialMessageId);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<SaveAiAssistantInput>(() => emptyForm());
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedIdRef = useRef(selectedId);
  const selectedThreadIdRef = useRef<string | null>(null);
  const handledCreateRequestRef = useRef(createRequestVersion);

  const selectedAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === selectedId) ?? null,
    [assistants, selectedId],
  );
  const selectedThreadId = selectedId ? (selectedThreadIds[selectedId] ?? null) : null;
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const visibleThreads = useMemo(
    () => (showArchivedThreads ? threads : threads.filter((thread) => !thread.archived)),
    [showArchivedThreads, threads],
  );
  const processableAssistantFiles = useMemo(
    () => assistantFiles.filter((file) => file.processable),
    [assistantFiles],
  );
  const selectedAssistantFiles = useMemo(
    () => assistantFiles.filter((file) => selectedFileIds.includes(file.id)),
    [assistantFiles, selectedFileIds],
  );
  const defaultModel = models.models.find((model) => model.id === models.selectedModelId) ?? null;
  const draft = selectedThreadId ? (drafts[selectedThreadId] ?? "") : "";
  const updateDraft = useCallback(
    (value: string) => {
      if (!selectedThreadId) return;
      setDrafts((current) => {
        const next = { ...current };
        if (value) next[selectedThreadId] = value;
        else delete next[selectedThreadId];
        return next;
      });
    },
    [selectedThreadId],
  );
  const showNotice = useCallback((tone: "error" | "success", text: string) => {
    setNotice({ tone, text });
  }, []);

  // 完成提示短暂停留，错误提示保留更久；新提示会重新计算阅读时间。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DISMISS_DELAY[notice.tone]);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    let active = true;
    Promise.all([api.aiAssistants(), api.aiModels(), api.knowledgeBases()])
      .then(([assistantResult, modelResult, knowledgeResult]) => {
        if (!active) return;
        setAssistants(assistantResult.assistants);
        setModels(modelResult);
        setKnowledgeBases(knowledgeResult.knowledgeBases);
        const initialSelectedId = selectedIdRef.current;
        const requested = assistantResult.assistants.some(
          (assistant) => assistant.id === initialSelectedId,
        )
          ? initialSelectedId
          : null;
        onSelectedIdChange(requested ?? assistantResult.assistants[0]?.id ?? null);
      })
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "智能助理加载失败") });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onSelectedIdChange]);

  useEffect(() => {
    onDirectoryChange({ assistants, loading });
  }, [assistants, loading, onDirectoryChange]);

  useEffect(() => {
    if (refreshVersion === 0) return;
    void api
      .aiAssistants()
      .then((result) => setAssistants(result.assistants))
      .catch(() => undefined);
  }, [refreshVersion]);

  useEffect(() => {
    setShowArchivedThreads(false);
  }, [selectedId]);

  // 对话目录始终包含归档项，是否展示仅由界面控制，避免归档/恢复后重复请求和状态跳变。
  useEffect(() => {
    let active = true;
    setThreads([]);
    setMessages([]);
    setConfirmClear(false);
    setLoadingThreads(Boolean(selectedId));
    if (!selectedId) return () => undefined;
    void api
      .aiAssistantThreads(selectedId, true)
      .then((result) => {
        if (!active) return;
        setThreads(result.threads);
        setSelectedThreadIds((current) => {
          const remembered = current[selectedId];
          const preferred = result.threads.some((thread) => thread.id === remembered)
            ? remembered
            : null;
          const nextId =
            preferred ??
            result.threads.find((thread) => !thread.archived)?.id ??
            result.threads[0]?.id;
          if (!nextId || current[selectedId] === nextId) return current;
          return { ...current, [selectedId]: nextId };
        });
      })
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "对话目录加载失败") });
      })
      .finally(() => {
        if (active) setLoadingThreads(false);
      });
    return () => {
      active = false;
    };
  }, [refreshVersion, selectedId]);

  // 通知可直接携带 threadId；旧通知只有 messageId 时再通过服务端定位所属对话。
  useEffect(() => {
    if ((!initialMessageId && !initialThreadId) || !selectedId) return () => undefined;
    let active = true;
    setWorkspaceMode("chat");
    const location = initialThreadId
      ? Promise.resolve({ threadId: initialThreadId })
      : api.aiAssistantMessageLocation(selectedId, initialMessageId!);
    void location
      .then(({ threadId }) => {
        if (!active) return;
        setSelectedThreadIds((current) => ({ ...current, [selectedId]: threadId }));
        setTargetMessageId(initialMessageId ?? null);
        setMessageLoadVersion((current) => current + 1);
      })
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "原消息定位失败") });
      });
    return () => {
      active = false;
    };
  }, [initialMessageId, initialThreadId, selectedId]);

  useEffect(() => {
    if (selectedThread?.archived) setShowArchivedThreads(true);
  }, [selectedThread]);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setConfirmClear(false);
    setConfirmDelete(false);
    if (!selectedId || !selectedThreadId) {
      setLoadingMessages(false);
      return () => undefined;
    }
    setLoadingMessages(true);
    void api
      .aiAssistantMessages(selectedId, selectedThreadId)
      .then((result) => {
        if (active) setMessages(result.messages);
      })
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "对话记录加载失败") });
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [messageLoadVersion, refreshVersion, selectedId, selectedThreadId]);

  useEffect(() => {
    let active = true;
    setAssistantFiles([]);
    setSelectedFileIds([]);
    setFilePickerOpen(false);
    setSaveFileDraft(null);
    if (!selectedId) return () => undefined;
    setLoadingFiles(true);
    void api
      .aiAssistantFiles(selectedId)
      .then((result) => {
        if (active) setAssistantFiles(result.files);
      })
      .catch((error) => {
        if (active) setNotice({ tone: "error", text: errorMessage(error, "助理文件加载失败") });
      })
      .finally(() => {
        if (active) setLoadingFiles(false);
      });
    return () => {
      active = false;
    };
  }, [refreshVersion, selectedId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sendingText, selectedId, selectedThreadId]);

  useEffect(() => {
    if (!targetMessageId || loadingMessages || workspaceMode !== "chat") return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`assistant-message-${targetMessageId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setTargetMessageId(null), 2600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [loadingMessages, messages, targetMessageId, workspaceMode]);

  const openTaskMessage = useCallback((messageId: string) => {
    setWorkspaceMode("chat");
    setTargetMessageId(messageId);
    setMessageLoadVersion((current) => current + 1);
  }, []);

  const selectThread = useCallback(
    (threadId: string) => {
      if (!selectedId || threadId === selectedThreadId) return;
      if (sendingText) {
        showNotice("error", "请等待当前回复完成后再切换对话");
        return;
      }
      setSelectedThreadIds((current) => ({ ...current, [selectedId]: threadId }));
      setTargetMessageId(null);
      setConfirmClear(false);
      setFilePickerOpen(false);
      setSelectedFileIds([]);
    },
    [selectedId, selectedThreadId, sendingText, showNotice],
  );

  const createThread = useCallback(
    async (title: string) => {
      if (!selectedId || threadBusyId || sendingText) return false;
      setThreadBusyId("create");
      try {
        const result = await api.createAiAssistantThread(selectedId, title);
        setThreads((current) => [result.thread, ...current]);
        setSelectedThreadIds((current) => ({ ...current, [selectedId]: result.thread.id }));
        setShowArchivedThreads(false);
        showNotice("success", `已创建“${result.thread.title}”`);
        return true;
      } catch (error) {
        showNotice("error", errorMessage(error, "新建对话失败"));
        return false;
      } finally {
        setThreadBusyId(null);
      }
    },
    [selectedId, sendingText, showNotice, threadBusyId],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!selectedId || threadBusyId) return false;
      setThreadBusyId(threadId);
      try {
        const result = await api.updateAiAssistantThread(selectedId, threadId, { title });
        setThreads((current) =>
          current.map((thread) => (thread.id === result.thread.id ? result.thread : thread)),
        );
        showNotice("success", "对话名称已更新");
        return true;
      } catch (error) {
        showNotice("error", errorMessage(error, "重命名失败"));
        return false;
      } finally {
        setThreadBusyId(null);
      }
    },
    [selectedId, showNotice, threadBusyId],
  );

  const toggleThreadArchived = useCallback(
    async (thread: AiAssistantThread) => {
      if (!selectedId || threadBusyId || sendingText) return;
      setThreadBusyId(thread.id);
      try {
        await api.updateAiAssistantThread(selectedId, thread.id, {
          archived: !thread.archived,
        });
        const result = await api.aiAssistantThreads(selectedId, true);
        setThreads(result.threads);
        if (!thread.archived && selectedThreadId === thread.id) {
          const nextThread = result.threads.find((item) => !item.archived);
          if (nextThread) {
            setSelectedThreadIds((current) => ({ ...current, [selectedId]: nextThread.id }));
          }
        }
        showNotice(
          "success",
          thread.archived ? `已恢复“${thread.title}”` : `已归档“${thread.title}”`,
        );
      } catch (error) {
        showNotice("error", errorMessage(error, thread.archived ? "恢复失败" : "归档失败"));
      } finally {
        setThreadBusyId(null);
      }
    },
    [selectedId, selectedThreadId, sendingText, showNotice, threadBusyId],
  );

  const openTaskBrowserRun = useCallback((runId: string) => {
    setBrowserFocusRunId(runId);
    setWorkspaceMode("browser");
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (saveFileDraft) setSaveFileDraft(null);
      else if (filePickerOpen) setFilePickerOpen(false);
      else if (editorMode) setEditorMode(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editorMode, filePickerOpen, saveFileDraft]);

  const openCreate = useCallback((preset = ASSISTANT_PRESETS[0]!) => {
    setForm(emptyForm(preset));
    setEditorMode("create");
    setConfirmDelete(false);
  }, []);

  useEffect(() => {
    if (createRequestVersion === 0 || createRequestVersion === handledCreateRequestRef.current) {
      return;
    }
    handledCreateRequestRef.current = createRequestVersion;
    openCreate();
  }, [createRequestVersion, openCreate]);

  const openEdit = () => {
    if (!selectedAssistant) return;
    setForm({
      name: selectedAssistant.name,
      description: selectedAssistant.description,
      category: selectedAssistant.category,
      instructions: selectedAssistant.instructions,
      avatarColor: selectedAssistant.avatarColor,
      modelId: models.models.some((model) => model.id === selectedAssistant.modelId)
        ? selectedAssistant.modelId
        : null,
      knowledgeBaseIds: selectedAssistant.knowledgeBaseIds,
    });
    setEditorMode("edit");
    setConfirmDelete(false);
  };

  const saveAssistant = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.instructions.trim() || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const input = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
        instructions: form.instructions.trim(),
      };
      if (editorMode === "edit" && selectedAssistant) {
        const result = await api.updateAiAssistant(selectedAssistant.id, input);
        setAssistants((current) =>
          current.map((assistant) =>
            assistant.id === result.assistant.id ? result.assistant : assistant,
          ),
        );
        setNotice({ tone: "success", text: "助理设置已保存" });
      } else {
        const result = await api.createAiAssistant(input);
        setAssistants((current) => [result.assistant, ...current]);
        onSelectedIdChange(result.assistant.id);
        setMessages([]);
        setNotice({ tone: "success", text: `${result.assistant.name} 已创建` });
      }
      setEditorMode(null);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "助理保存失败") });
    } finally {
      setSaving(false);
    }
  };

  const removeAssistant = async () => {
    if (!selectedAssistant || saving) return;
    setSaving(true);
    try {
      await api.deleteAiAssistant(selectedAssistant.id);
      const remaining = assistants.filter((assistant) => assistant.id !== selectedAssistant.id);
      setAssistants(remaining);
      onSelectedIdChange(remaining[0]?.id ?? null);
      setEditorMode(null);
      setNotice({ tone: "success", text: "智能助理已删除" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "删除失败") });
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  };

  const clearMessages = async () => {
    if (!selectedAssistant || !selectedThread || selectedThread.archived) return;
    try {
      await api.clearAiAssistantMessages(selectedAssistant.id, selectedThread.id);
      setMessages([]);
      const otherLastMessageAt = threads
        .filter((thread) => thread.id !== selectedThread.id && thread.lastMessageAt)
        .map((thread) => thread.lastMessageAt as string)
        .sort((left, right) => right.localeCompare(left))[0];
      setThreads((current) =>
        current.map((thread) =>
          thread.id === selectedThread.id
            ? { ...thread, messageCount: 0, lastMessageAt: null }
            : thread,
        ),
      );
      setAssistants((current) =>
        current.map((assistant) =>
          assistant.id === selectedAssistant.id
            ? {
                ...assistant,
                messageCount: Math.max(0, assistant.messageCount - selectedThread.messageCount),
                lastMessageAt: otherLastMessageAt ?? null,
              }
            : assistant,
        ),
      );
      setNotice({ tone: "success", text: `“${selectedThread.title}”已清空` });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "清空失败") });
    } finally {
      setConfirmClear(false);
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (
      !selectedAssistant ||
      !selectedThread ||
      selectedThread.archived ||
      !content ||
      sendingText
    ) {
      return;
    }
    const assistantId = selectedAssistant.id;
    const threadId = selectedThread.id;
    const fileIds = selectedFileIds;
    const referencedFiles = assistantFiles.filter((file) => fileIds.includes(file.id));
    updateDraft("");
    setSelectedFileIds([]);
    setFilePickerOpen(false);
    setSendingText(content);
    setSendingFiles(referencedFiles);
    setNotice(null);
    try {
      const result = await api.sendAiAssistantMessage(assistantId, threadId, content, fileIds);
      if (selectedIdRef.current === assistantId && selectedThreadIdRef.current === threadId) {
        setMessages((current) => [...current, ...result.messages]);
      }
      const lastMessageAt = result.messages.at(-1)?.createdAt ?? new Date().toISOString();
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                messageCount: thread.messageCount + result.messages.length,
                lastMessageAt,
                updatedAt: lastMessageAt,
              }
            : thread,
        ),
      );
      setAssistants((current) =>
        current.map((assistant) =>
          assistant.id === assistantId
            ? {
                ...assistant,
                messageCount: assistant.messageCount + result.messages.length,
                lastMessageAt,
              }
            : assistant,
        ),
      );
    } catch (error) {
      setDrafts((current) => ({ ...current, [threadId]: content }));
      setSelectedFileIds(
        fileIds.filter((fileId) => assistantFiles.some((file) => file.id === fileId)),
      );
      setNotice({ tone: "error", text: errorMessage(error, "助理暂时没有回复") });
    } finally {
      setSendingText(null);
      setSendingFiles([]);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
  };

  const openSource = async (source: KnowledgeSource) => {
    try {
      const blob = await api.fileBlob(source.document.attachment.id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "原文件打开失败") });
    }
  };

  const downloadAssistantFile = async (file: AiAssistantFile) => {
    try {
      const blob = await api.fileBlob(file.attachment.id, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.attachment.originalName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "文件下载失败") });
    }
  };

  const addAssistantFileToState = useCallback((file: AiAssistantFile) => {
    setAssistantFiles((current) => [file, ...current.filter((item) => item.id !== file.id)]);
  }, []);

  const removeAssistantFileFromState = useCallback((fileId: string) => {
    setAssistantFiles((current) => current.filter((file) => file.id !== fileId));
    setSelectedFileIds((current) => current.filter((id) => id !== fileId));
    setMessages((current) =>
      current.map((message) => ({
        ...message,
        referencedFiles: message.referencedFiles?.filter((file) => file.id !== fileId),
        generatedFiles: message.generatedFiles?.filter((file) => file.id !== fileId),
      })),
    );
  }, []);

  const openSaveFile = (message: AiAssistantMessage) => {
    if (!selectedAssistant) return;
    setSaveFileDraft({
      messageId: message.id,
      name: `${selectedAssistant.name}回复`,
      format: "MARKDOWN",
    });
  };

  const saveMessageAsFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedAssistant || !saveFileDraft || savingMessageFile) return;
    setSavingMessageFile(true);
    try {
      const result = await api.saveAiAssistantMessageFile(
        selectedAssistant.id,
        saveFileDraft.messageId,
        { format: saveFileDraft.format, name: saveFileDraft.name.trim() || undefined },
      );
      addAssistantFileToState(result.file);
      setMessages((current) =>
        current.map((message) =>
          message.id === saveFileDraft.messageId
            ? {
                ...message,
                generatedFiles: [
                  ...(message.generatedFiles ?? []).filter((file) => file.id !== result.file.id),
                  result.file,
                ],
              }
            : message,
        ),
      );
      setSaveFileDraft(null);
      setNotice({ tone: "success", text: `已保存为“${result.file.attachment.originalName}”` });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "助理回复保存失败") });
    } finally {
      setSavingMessageFile(false);
    }
  };

  return (
    <section className="assistant-surface" aria-label="智能助理工作区">
      <button
        className="assistant-mobile-back"
        type="button"
        onClick={onMobileBack}
        aria-label="返回助理列表"
      >
        <ChevronLeft size={21} />
      </button>

      {notice && (
        <div
          className={`assistant-notice ${notice.tone === "error" ? "is-error" : ""}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.tone === "success" ? <Check size={14} /> : <Sparkles size={14} />}
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      )}

      <div className={`assistant-workspace ${editorMode ? "has-editor" : ""}`}>
        <main className="assistant-chat-panel">
          {loading ? (
            <div className="assistant-workspace-loading" role="status">
              <LoaderCircle className="spin" size={22} />
              正在准备助理工作区
            </div>
          ) : !selectedAssistant ? (
            <div className="assistant-onboarding">
              <span className="assistant-onboarding-mark">
                <Sparkles size={30} />
              </span>
              <span
                className={`assistant-runtime ${capabilities.status === "READY" ? "is-ready" : ""}`}
                title={capabilities.reason}
              >
                <i />
                {capabilities.status === "READY" ? "AI 就绪" : capabilities.reason}
              </span>
              <h2>给每类工作一个合适的搭档</h2>
              <p>从一个轻量角色开始，再为它安排自动任务、模型和个人知识资料。</p>
              <div className="assistant-preset-grid">
                {ASSISTANT_PRESETS.map((preset) => (
                  <button type="button" key={preset.category} onClick={() => openCreate(preset)}>
                    <span style={{ "--preset-color": preset.avatarColor } as React.CSSProperties}>
                      {assistantCategoryIcon(preset.category, 19)}
                    </span>
                    <strong>{preset.name}</strong>
                    <small>
                      {preset.kicker} · {preset.description}
                    </small>
                    <ArrowUp size={15} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <header className="assistant-chat-header">
                <div>
                  <AssistantAvatar assistant={selectedAssistant} size="large" />
                  <span>
                    <strong>{selectedAssistant.name}</strong>
                    <small>
                      {selectedAssistant.description ||
                        ASSISTANT_CATEGORY_META[selectedAssistant.category].detail}
                    </small>
                  </span>
                </div>
                <div>
                  <div className="assistant-view-switch" role="tablist" aria-label="助理工作区">
                    <button
                      type="button"
                      className={workspaceMode === "chat" ? "is-active" : ""}
                      role="tab"
                      aria-selected={workspaceMode === "chat"}
                      onClick={() => setWorkspaceMode("chat")}
                    >
                      <MessageSquareText size={13} />
                      对话
                    </button>
                    <button
                      type="button"
                      className={workspaceMode === "tasks" ? "is-active" : ""}
                      role="tab"
                      aria-selected={workspaceMode === "tasks"}
                      onClick={() => setWorkspaceMode("tasks")}
                    >
                      <CalendarClock size={13} />
                      任务
                    </button>
                    <button
                      type="button"
                      className={workspaceMode === "files" ? "is-active" : ""}
                      role="tab"
                      aria-selected={workspaceMode === "files"}
                      onClick={() => setWorkspaceMode("files")}
                    >
                      <FolderOpen size={13} />
                      文件
                    </button>
                    <button
                      type="button"
                      className={workspaceMode === "browser" ? "is-active" : ""}
                      role="tab"
                      aria-selected={workspaceMode === "browser"}
                      onClick={() => setWorkspaceMode("browser")}
                    >
                      <Globe2 size={13} />
                      浏览器
                    </button>
                  </div>
                  <span
                    className={`assistant-runtime assistant-runtime-compact ${capabilities.status === "READY" ? "is-ready" : ""}`}
                    title={capabilities.reason}
                  >
                    <i />
                    {capabilities.status === "READY" ? "AI 就绪" : "AI 不可用"}
                  </span>
                  <span className="assistant-model-badge">
                    <BrainCircuit size={13} />
                    {selectedAssistant.model?.name ?? defaultModel?.name ?? "跟随默认模型"}
                  </span>
                  <button type="button" onClick={openEdit} aria-label="编辑助理">
                    <Settings2 size={17} />
                  </button>
                  {workspaceMode === "chat" && (
                    <button
                      type="button"
                      onClick={() => setConfirmClear(true)}
                      aria-label="清空对话"
                      disabled={messages.length === 0 || selectedThread?.archived}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  )}
                </div>
              </header>
              <AssistantThreadBar
                threads={visibleThreads}
                selectedId={selectedThreadId}
                loading={loadingThreads}
                busyId={threadBusyId ?? (sendingText ? selectedThreadId : null)}
                showArchived={showArchivedThreads}
                onSelect={selectThread}
                onCreate={createThread}
                onRename={renameThread}
                onToggleArchived={toggleThreadArchived}
                onToggleShowArchived={() => setShowArchivedThreads((current) => !current)}
              />
              {loadingThreads || !selectedThread ? (
                <div className="assistant-workspace-loading" role="status">
                  <LoaderCircle className="spin" size={20} />
                  正在准备对话
                </div>
              ) : workspaceMode === "tasks" ? (
                <AssistantTasksPanel
                  assistant={selectedAssistant}
                  threadId={selectedThread.id}
                  files={assistantFiles}
                  refreshVersion={refreshVersion}
                  onNotice={showNotice}
                  onOpenMessage={openTaskMessage}
                  onOpenBrowserRun={openTaskBrowserRun}
                  onOpenBrowserSettings={() => {
                    setBrowserFocusRunId(null);
                    setWorkspaceMode("browser");
                  }}
                  onOpenFiles={() => setWorkspaceMode("files")}
                />
              ) : workspaceMode === "files" ? (
                <AssistantFilesPanel
                  assistant={selectedAssistant}
                  files={assistantFiles}
                  loading={loadingFiles}
                  onFileAdded={addAssistantFileToState}
                  onFileRemoved={removeAssistantFileFromState}
                  onNotice={showNotice}
                />
              ) : workspaceMode === "browser" ? (
                <AssistantBrowserPanel
                  assistant={selectedAssistant}
                  focusRunId={browserFocusRunId}
                  onNotice={showNotice}
                  onFilesChanged={() => {
                    setLoadingFiles(true);
                    void api
                      .aiAssistantFiles(selectedAssistant.id)
                      .then((result) => setAssistantFiles(result.files))
                      .catch((error) =>
                        showNotice("error", errorMessage(error, "助理文件刷新失败")),
                      )
                      .finally(() => setLoadingFiles(false));
                  }}
                />
              ) : (
                <>
                  {confirmClear && (
                    <div className="assistant-inline-confirm">
                      <span>清空“{selectedThread.title}”中的全部消息？</span>
                      <button type="button" onClick={() => setConfirmClear(false)}>
                        取消
                      </button>
                      <button type="button" onClick={() => void clearMessages()}>
                        清空
                      </button>
                    </div>
                  )}
                  <div className="assistant-message-scroll">
                    {loadingMessages ? (
                      <div className="assistant-message-loading">
                        <LoaderCircle className="spin" size={22} />
                        正在读取对话
                      </div>
                    ) : messages.length === 0 && !sendingText ? (
                      <div className="assistant-conversation-empty">
                        <AssistantAvatar assistant={selectedAssistant} size="large" />
                        <h3>我是 {selectedAssistant.name}</h3>
                        <p>{selectedAssistant.instructions}</p>
                        <div>
                          <span>{ASSISTANT_CATEGORY_META[selectedAssistant.category].label}</span>
                          <span>
                            {selectedAssistant.knowledgeBaseIds.length > 0
                              ? `已连接 ${selectedAssistant.knowledgeBaseIds.length} 个知识库`
                              : "未连接知识库"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="assistant-message-list">
                        {messages.map((message) => (
                          <article
                            id={`assistant-message-${message.id}`}
                            className={`assistant-message ${message.role === "USER" ? "is-user" : "is-assistant"} ${targetMessageId === message.id ? "is-highlighted" : ""}`}
                            key={message.id}
                          >
                            {message.role === "ASSISTANT" && (
                              <AssistantAvatar assistant={selectedAssistant} />
                            )}
                            <div>
                              <p>{message.content}</p>
                              {(message.sources.length > 0 ||
                                (message.referencedFiles?.length ?? 0) > 0 ||
                                (message.generatedFiles?.length ?? 0) > 0) && (
                                <footer className="assistant-message-resources">
                                  {message.sources.map((source) => (
                                    <SourceChip
                                      key={source.chunkId}
                                      source={source}
                                      onOpen={() => void openSource(source)}
                                    />
                                  ))}
                                  {(message.referencedFiles ?? []).map((file) => (
                                    <AssistantMessageFileChip
                                      key={`reference-${file.id}`}
                                      file={file}
                                      onDownload={() => void downloadAssistantFile(file)}
                                    />
                                  ))}
                                  {(message.generatedFiles ?? []).map((file) => (
                                    <AssistantMessageFileChip
                                      key={`generated-${file.id}`}
                                      file={file}
                                      onDownload={() => void downloadAssistantFile(file)}
                                    />
                                  ))}
                                </footer>
                              )}
                              <div className="assistant-message-meta">
                                <small>
                                  {new Intl.DateTimeFormat("zh-CN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }).format(new Date(message.createdAt))}
                                  {message.role === "ASSISTANT" && message.model
                                    ? ` · ${message.model.name}`
                                    : ""}
                                </small>
                                {message.role === "ASSISTANT" && (
                                  <button
                                    type="button"
                                    onClick={() => openSaveFile(message)}
                                    aria-label="将这条回复保存为文件"
                                    title="保存为文件"
                                  >
                                    <Save size={13} />
                                  </button>
                                )}
                              </div>
                              {saveFileDraft?.messageId === message.id && (
                                <form
                                  className="assistant-save-file-popover"
                                  onSubmit={(event) => void saveMessageAsFile(event)}
                                >
                                  <header>
                                    <span>
                                      <Save size={14} /> 保存回复
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setSaveFileDraft(null)}
                                      aria-label="关闭保存文件"
                                    >
                                      <X size={13} />
                                    </button>
                                  </header>
                                  <label>
                                    <span>文件名</span>
                                    <input
                                      value={saveFileDraft.name}
                                      onChange={(event) =>
                                        setSaveFileDraft((current) =>
                                          current ? { ...current, name: event.target.value } : null,
                                        )
                                      }
                                      maxLength={180}
                                      autoFocus
                                    />
                                  </label>
                                  <div>
                                    <button
                                      type="button"
                                      className={
                                        saveFileDraft.format === "MARKDOWN" ? "is-active" : ""
                                      }
                                      onClick={() =>
                                        setSaveFileDraft((current) =>
                                          current ? { ...current, format: "MARKDOWN" } : null,
                                        )
                                      }
                                    >
                                      Markdown
                                    </button>
                                    <button
                                      type="button"
                                      className={saveFileDraft.format === "TEXT" ? "is-active" : ""}
                                      onClick={() =>
                                        setSaveFileDraft((current) =>
                                          current ? { ...current, format: "TEXT" } : null,
                                        )
                                      }
                                    >
                                      TXT
                                    </button>
                                    <button type="submit" disabled={savingMessageFile}>
                                      {savingMessageFile ? (
                                        <LoaderCircle className="spin" size={13} />
                                      ) : (
                                        <Save size={13} />
                                      )}
                                      保存
                                    </button>
                                  </div>
                                </form>
                              )}
                            </div>
                          </article>
                        ))}
                        {sendingText && (
                          <>
                            <article className="assistant-message is-user is-pending">
                              <div>
                                <p>{sendingText}</p>
                                {sendingFiles.length > 0 && (
                                  <footer className="assistant-message-resources">
                                    {sendingFiles.map((file) => (
                                      <span
                                        className="assistant-message-file-chip is-static"
                                        key={file.id}
                                      >
                                        <FileText size={14} />
                                        <span>{file.attachment.originalName}</span>
                                      </span>
                                    ))}
                                  </footer>
                                )}
                              </div>
                            </article>
                            <article className="assistant-message is-assistant is-thinking">
                              <AssistantAvatar assistant={selectedAssistant} />
                              <div>
                                <span>
                                  <i />
                                  <i />
                                  <i />
                                </span>
                                <small>{selectedAssistant.name} 正在思考</small>
                              </div>
                            </article>
                          </>
                        )}
                      </div>
                    )}
                    <div ref={messageEndRef} />
                  </div>
                  {selectedThread.archived ? (
                    <div className="assistant-thread-archived-note">
                      <span>
                        <strong>这条对话已归档</strong>
                        <small>历史消息仍然保留，恢复后可继续发送和执行自动任务。</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => void toggleThreadArchived(selectedThread)}
                        disabled={Boolean(threadBusyId)}
                      >
                        <ArchiveRestore size={14} />
                        恢复对话
                      </button>
                    </div>
                  ) : (
                    <form
                      className="assistant-composer"
                      onSubmit={(event) => void sendMessage(event)}
                    >
                      {filePickerOpen && (
                        <div className="assistant-composer-file-picker">
                          <header>
                            <span>
                              <Paperclip size={14} />
                              选择本轮要读取的文件
                            </span>
                            <small>{selectedFileIds.length} / 5</small>
                          </header>
                          <div>
                            {processableAssistantFiles.length === 0 ? (
                              <button
                                type="button"
                                className="assistant-composer-file-empty"
                                onClick={() => {
                                  setFilePickerOpen(false);
                                  setWorkspaceMode("files");
                                }}
                              >
                                <FolderOpen size={18} />
                                <span>
                                  <strong>还没有可读取的文档</strong>
                                  <small>前往文件工作区添加 PDF、DOCX、Markdown 或文本</small>
                                </span>
                              </button>
                            ) : (
                              processableAssistantFiles.map((file) => {
                                const selected = selectedFileIds.includes(file.id);
                                return (
                                  <label key={file.id}>
                                    <input
                                      type="checkbox"
                                      checked={selected}
                                      disabled={!selected && selectedFileIds.length >= 5}
                                      onChange={() =>
                                        setSelectedFileIds((current) =>
                                          selected
                                            ? current.filter((id) => id !== file.id)
                                            : [...current, file.id].slice(0, 5),
                                        )
                                      }
                                    />
                                    <FileText size={15} />
                                    <span title={file.attachment.originalName}>
                                      {file.attachment.originalName}
                                    </span>
                                    <i>{selected && <Check size={11} />}</i>
                                  </label>
                                );
                              })
                            )}
                          </div>
                          <footer>
                            <span>只有勾选的文件会在本轮发送提取后的文字</span>
                            <button
                              type="button"
                              onClick={() => {
                                setFilePickerOpen(false);
                                setWorkspaceMode("files");
                              }}
                            >
                              管理文件
                            </button>
                          </footer>
                        </div>
                      )}
                      {selectedAssistantFiles.length > 0 && (
                        <div className="assistant-composer-selected-files">
                          {selectedAssistantFiles.map((file) => (
                            <span key={file.id}>
                              <FileText size={12} />
                              <b>{file.attachment.originalName}</b>
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedFileIds((current) =>
                                    current.filter((id) => id !== file.id),
                                  )
                                }
                                aria-label={`取消引用 ${file.attachment.originalName}`}
                              >
                                <X size={11} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <textarea
                        ref={composerRef}
                        value={draft}
                        onChange={(event) => updateDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void sendMessage();
                          }
                        }}
                        placeholder={`给 ${selectedAssistant.name} 发消息`}
                        rows={2}
                        maxLength={4000}
                        disabled={Boolean(sendingText)}
                      />
                      <footer>
                        <div>
                          <button
                            className={`assistant-composer-attach ${filePickerOpen ? "is-active" : ""}`}
                            type="button"
                            onClick={() => setFilePickerOpen((current) => !current)}
                            aria-label="引用助理文件"
                            aria-expanded={filePickerOpen}
                          >
                            <Paperclip size={15} />
                            {selectedFileIds.length > 0 && <b>{selectedFileIds.length}</b>}
                          </button>
                          <span>
                            <MessageSquareText size={13} />
                            Enter 发送 · Shift + Enter 换行
                          </span>
                        </div>
                        <button
                          type="submit"
                          disabled={!draft.trim() || Boolean(sendingText)}
                          aria-label="发送给智能助理"
                        >
                          <Send size={17} />
                        </button>
                      </footer>
                    </form>
                  )}
                </>
              )}
            </>
          )}
        </main>

        {editorMode && (
          <aside className="assistant-editor-panel">
            <header>
              <span>
                <strong>{editorMode === "create" ? "创建智能助理" : "助理设置"}</strong>
                <small>角色说明会用于每一次回复</small>
              </span>
              <button type="button" onClick={() => setEditorMode(null)} aria-label="关闭助理设置">
                <X size={16} />
              </button>
            </header>
            <form onSubmit={(event) => void saveAssistant(event)}>
              <label>
                <span>名称</span>
                <input
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  maxLength={80}
                  autoFocus
                />
              </label>
              <label>
                <span>
                  简介 <small>可选</small>
                </span>
                <input
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                  maxLength={240}
                  placeholder="一句话说明它擅长什么"
                />
              </label>
              <fieldset>
                <legend>类型</legend>
                <div className="assistant-category-grid">
                  {(Object.keys(ASSISTANT_CATEGORY_META) as AiAssistantCategory[]).map(
                    (category) => (
                      <button
                        className={form.category === category ? "is-active" : ""}
                        type="button"
                        key={category}
                        aria-pressed={form.category === category}
                        onClick={() => setForm((current) => ({ ...current, category }))}
                      >
                        {assistantCategoryIcon(category, 15)}
                        <span>
                          <strong>{ASSISTANT_CATEGORY_META[category].label}</strong>
                          <small>{ASSISTANT_CATEGORY_META[category].detail}</small>
                        </span>
                      </button>
                    ),
                  )}
                </div>
              </fieldset>
              <label>
                <span>角色说明</span>
                <textarea
                  value={form.instructions}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, instructions: event.target.value }))
                  }
                  rows={6}
                  maxLength={6000}
                  placeholder="说明语气、工作方法和输出偏好"
                />
              </label>
              <label>
                <span>对话模型</span>
                <select
                  value={form.modelId ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, modelId: event.target.value || null }))
                  }
                >
                  <option value="">
                    跟随我的默认模型{defaultModel ? ` · ${defaultModel.name}` : ""}
                  </option>
                  {models.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.providerModel}
                    </option>
                  ))}
                </select>
                {form.modelId && !models.models.some((model) => model.id === form.modelId) && (
                  <small className="assistant-field-warning">
                    原模型不可用，保存后将跟随默认模型
                  </small>
                )}
              </label>
              <fieldset>
                <legend>
                  个人知识库 <small>可选，最多 10 个</small>
                </legend>
                {knowledgeBases.length === 0 ? (
                  <div className="assistant-knowledge-empty">
                    <LibraryBig size={16} />
                    暂无知识库，可稍后在“团队知识库”中创建或接受共享
                  </div>
                ) : (
                  <div className="assistant-knowledge-options">
                    {knowledgeBases.map((base) => {
                      const checked = form.knowledgeBaseIds.includes(base.id);
                      return (
                        <label key={base.id}>
                          <input
                            type="checkbox"
                            aria-label={`绑定知识库 ${base.name}`}
                            checked={checked}
                            onChange={() =>
                              setForm((current) => ({
                                ...current,
                                knowledgeBaseIds: checked
                                  ? current.knowledgeBaseIds.filter((id) => id !== base.id)
                                  : [...current.knowledgeBaseIds, base.id].slice(0, 10),
                              }))
                            }
                          />
                          <span>
                            <strong>{base.name}</strong>
                            <small>{base.readyDocumentCount} 份资料可用</small>
                          </span>
                          <i>{checked && <Check size={12} />}</i>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend>头像颜色</legend>
                <div className="assistant-color-options">
                  {AVATAR_COLORS.map((color) => (
                    <button
                      className={form.avatarColor === color ? "is-active" : ""}
                      type="button"
                      key={color}
                      aria-label={`选择头像颜色 ${color}`}
                      aria-pressed={form.avatarColor === color}
                      style={{ "--assistant-color": color } as React.CSSProperties}
                      onClick={() => setForm((current) => ({ ...current, avatarColor: color }))}
                    >
                      {form.avatarColor === color && <Check size={13} />}
                    </button>
                  ))}
                </div>
              </fieldset>
              {editorMode === "edit" && (
                <div className="assistant-danger-zone">
                  {confirmDelete ? (
                    <>
                      <span>删除后对话记录也会消失</span>
                      <button type="button" onClick={() => setConfirmDelete(false)}>
                        取消
                      </button>
                      <button type="button" onClick={() => void removeAssistant()}>
                        确认删除
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)}>
                      <Trash2 size={14} />
                      删除这个助理
                    </button>
                  )}
                </div>
              )}
              <footer>
                <button type="button" onClick={() => setEditorMode(null)}>
                  取消
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.name.trim() || !form.instructions.trim()}
                >
                  {saving ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : editorMode === "create" ? (
                    <Plus size={15} />
                  ) : (
                    <PencilLine size={15} />
                  )}
                  {editorMode === "create" ? "创建助理" : "保存设置"}
                </button>
              </footer>
            </form>
          </aside>
        )}
      </div>
    </section>
  );
}
