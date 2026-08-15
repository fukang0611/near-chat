import type {
  MemoryCandidate,
  MemoryKind,
  MemoryRecord,
  MemorySettings,
  MemoryTier,
} from "@near-chat/contracts";
import {
  BrainCircuit,
  Check,
  Clock3,
  ExternalLink,
  Inbox,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api";
import { errorMessage } from "../utils/errors";

interface MemoryCenterDialogProps {
  onClose: () => void;
  onNotify?: (message: string, tone: "success" | "error" | "info") => void;
  onOpenMessage?: (conversationId: string, messageId: string) => void;
}

interface MemoryDraft {
  title: string;
  content: string;
  kind: MemoryKind;
  importance: number;
}

type MemoryView = MemoryTier | "CANDIDATES";

const memoryKinds: Array<{ value: MemoryKind; label: string; detail: string }> = [
  { value: "NOTE", label: "备忘", detail: "需要持续保留的信息" },
  { value: "PREFERENCE", label: "偏好", detail: "个人习惯与工作偏好" },
  { value: "PERSON", label: "人物", detail: "成员背景与协作方式" },
  { value: "PROJECT", label: "项目", detail: "项目背景和稳定事实" },
  { value: "DECISION", label: "决定", detail: "已经确认的重要结论" },
  { value: "PROCEDURE", label: "流程", detail: "固定步骤和处理方法" },
  { value: "GOAL", label: "目标", detail: "需要持续推进的方向" },
  { value: "TASK_CONTEXT", label: "任务上下文", detail: "跨阶段工作的必要背景" },
];

const kindByValue = new Map(memoryKinds.map((kind) => [kind.value, kind]));
const emptyDraft: MemoryDraft = { title: "", content: "", kind: "NOTE", importance: 3 };

function memoryDraft(memory: MemoryRecord): MemoryDraft {
  return {
    title: memory.title,
    content: memory.content,
    kind: memory.kind,
    importance: memory.importance,
  };
}

function sameDraft(left: MemoryDraft, right: MemoryDraft): boolean {
  return (
    left.title === right.title &&
    left.content === right.content &&
    left.kind === right.kind &&
    left.importance === right.importance
  );
}

function formatMemoryTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function expiryLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "已到期";
  return `还剩 ${Math.max(1, Math.ceil(remaining / 86_400_000))} 天`;
}

/**
 * 私人记忆中心只调用 NearChat 原生接口。手动维护与明确意图识别不依赖 LLM；
 * 智能整理必须由用户主动开启，Embedding 不可用时搜索自动保留关键词结果。
 */
export function MemoryCenterDialog({ onClose, onNotify, onOpenMessage }: MemoryCenterDialogProps) {
  const [view, setView] = useState<MemoryView>("LONG_TERM");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKind | "ALL">("ALL");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [searchMode, setSearchMode] = useState<"KEYWORD" | "HYBRID">("KEYWORD");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [candidatesError, setCandidatesError] = useState("");
  const [candidateBusyIds, setCandidateBusyIds] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState<"EXPLICIT" | "SEMANTIC" | null>(null);
  const requestIdRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const activeTier: MemoryTier = view === "SHORT_TERM" ? "SHORT_TERM" : "LONG_TERM";
  const isShortTerm = activeTier === "SHORT_TERM";
  const tierLabel = isShortTerm ? "短期记忆" : "长期记忆";
  const selectedMemory = useMemo(
    () => memories.find((memory) => memory.id === selectedId) ?? null,
    [memories, selectedId],
  );
  const originalDraft = selectedMemory ? memoryDraft(selectedMemory) : emptyDraft;
  const dirty = creating
    ? Boolean(draft.title.trim() || draft.content.trim())
    : Boolean(selectedMemory && !sameDraft(draft, originalDraft));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const loadMemories = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const page = await api.memories({
        keyword: debouncedKeyword || undefined,
        kind: kindFilter === "ALL" ? undefined : kindFilter,
        tier: activeTier,
        limit: 200,
      });
      if (requestId !== requestIdRef.current) return;
      setMemories(page.memories);
      setTotal(page.total);
      setSearchMode(page.searchMode);
      setSelectedId((current) =>
        current && page.memories.some((memory) => memory.id === current)
          ? current
          : (page.memories[0]?.id ?? null),
      );
    } catch (loadFailure) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(errorMessage(loadFailure, "记忆列表加载失败"));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [activeTier, debouncedKeyword, kindFilter]);

  const loadCandidates = useCallback(async () => {
    setCandidatesLoading(true);
    setCandidatesError("");
    try {
      const page = await api.memoryCandidates();
      setCandidates(page.candidates);
    } catch (loadFailure) {
      setCandidatesError(errorMessage(loadFailure, "记忆候选加载失败"));
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "CANDIDATES") void loadMemories();
  }, [loadMemories, view]);

  useEffect(() => {
    void loadCandidates();
    void api
      .memorySettings()
      .then(({ settings: loadedSettings }) => setSettings(loadedSettings))
      .catch(() => setSettings(null));
  }, [loadCandidates]);

  useEffect(() => {
    if (!creating && selectedMemory) setDraft(memoryDraft(selectedMemory));
    setSaveError("");
    setForgetConfirm(false);
  }, [creating, selectedMemory]);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving && candidateBusyIds.size === 0) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [candidateBusyIds.size, onClose, saving]);

  const selectView = (next: MemoryView) => {
    if (saving || candidateBusyIds.size > 0 || next === view) return;
    requestIdRef.current += 1;
    setView(next);
    setKeyword("");
    setDebouncedKeyword("");
    setKindFilter("ALL");
    setMemories([]);
    setTotal(0);
    setSelectedId(null);
    setCreating(false);
    setDraft(emptyDraft);
    setLoadError("");
    if (next === "CANDIDATES") void loadCandidates();
  };

  const startCreating = () => {
    setCreating(true);
    setSelectedId(null);
    setDraft(emptyDraft);
    setSaveError("");
  };

  const selectMemory = (memory: MemoryRecord) => {
    if (saving) return;
    setCreating(false);
    setSelectedId(memory.id);
    setDraft(memoryDraft(memory));
  };

  const saveMemory = async () => {
    const input = {
      title: draft.title.trim(),
      content: draft.content.trim(),
      kind: draft.kind,
      importance: draft.importance,
      tier: activeTier,
    };
    if (!input.title || !input.content || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      if (creating) {
        const { memory } = await api.createMemory(input);
        setKeyword("");
        setDebouncedKeyword("");
        setKindFilter("ALL");
        setMemories((current) => [memory, ...current.filter((item) => item.id !== memory.id)]);
        setTotal((current) => current + 1);
        setSelectedId(memory.id);
        setCreating(false);
        setDraft(memoryDraft(memory));
        onNotify?.(`已保存到${tierLabel}`, "success");
      } else if (selectedMemory) {
        const { memory } = await api.updateMemory(selectedMemory.id, {
          title: input.title,
          content: input.content,
          kind: input.kind,
          importance: input.importance,
          baseRevision: selectedMemory.revision,
        });
        setMemories((current) => current.map((item) => (item.id === memory.id ? memory : item)));
        setDraft(memoryDraft(memory));
        onNotify?.("记忆已更新", "success");
      }
    } catch (saveFailure) {
      setSaveError(errorMessage(saveFailure, "记忆保存失败"));
      if (saveFailure instanceof ApiError && saveFailure.status === 409) await loadMemories();
    } finally {
      setSaving(false);
    }
  };

  const forgetSelectedMemory = async () => {
    if (!selectedMemory || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await api.forgetMemory(selectedMemory.id);
      const remaining = memories.filter((memory) => memory.id !== selectedMemory.id);
      setMemories(remaining);
      setTotal((current) => Math.max(0, current - 1));
      setSelectedId(remaining[0]?.id ?? null);
      setForgetConfirm(false);
      onNotify?.("已遗忘这条记忆", "success");
    } catch (forgetFailure) {
      setSaveError(errorMessage(forgetFailure, "暂时无法遗忘这条记忆"));
    } finally {
      setSaving(false);
    }
  };

  const handleCandidate = async (candidate: MemoryCandidate, action: "REJECT" | MemoryTier) => {
    if (candidateBusyIds.has(candidate.id)) return;
    setCandidateBusyIds((current) => new Set(current).add(candidate.id));
    try {
      if (action === "REJECT") {
        await api.rejectMemoryCandidate(candidate.id);
        onNotify?.("已忽略这条记忆候选", "info");
      } else {
        await api.acceptMemoryCandidate(candidate.id, action);
        onNotify?.(action === "SHORT_TERM" ? "已保留 7 天" : "已转为长期记忆", "success");
      }
      setCandidates((current) => current.filter((item) => item.id !== candidate.id));
    } catch (failure) {
      setCandidatesError(errorMessage(failure, "候选处理失败，请稍后重试"));
    } finally {
      setCandidateBusyIds((current) => {
        const next = new Set(current);
        next.delete(candidate.id);
        return next;
      });
    }
  };

  const toggleExplicitCapture = async () => {
    if (!settings || settingsBusy) return;
    const next = !settings.explicitCaptureEnabled;
    setSettingsBusy("EXPLICIT");
    try {
      const result = await api.updateMemorySettings({ explicitCaptureEnabled: next });
      setSettings(result.settings);
      onNotify?.(next ? "已开启明确记忆意图识别" : "已关闭自动识别", "success");
    } catch (failure) {
      onNotify?.(errorMessage(failure, "记忆设置保存失败"), "error");
    } finally {
      setSettingsBusy(null);
    }
  };

  const toggleSemanticCapture = async () => {
    if (!settings || settingsBusy) return;
    const next = !settings.semanticCaptureEnabled;
    setSettingsBusy("SEMANTIC");
    try {
      const result = await api.updateMemorySettings({ semanticCaptureEnabled: next });
      setSettings(result.settings);
      onNotify?.(next ? "已开启会话智能整理" : "已关闭会话智能整理", "success");
    } catch (failure) {
      onNotify?.(errorMessage(failure, "记忆设置保存失败"), "error");
    } finally {
      setSettingsBusy(null);
    }
  };

  const formVisible = creating || Boolean(selectedMemory);
  const headerCount = view === "CANDIDATES" ? candidates.length : total;
  const headerCountLabel = view === "CANDIDATES" ? "条待确认" : `条${tierLabel}`;

  return createPortal(
    <div
      className="memory-center-layer"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !saving && candidateBusyIds.size === 0 && onClose()
      }
    >
      <section
        className="memory-center-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-center-title"
      >
        <header className="memory-center-header">
          <span className="memory-center-mark" aria-hidden="true">
            <BrainCircuit size={23} />
          </span>
          <div>
            <small>PERSONAL MEMORY</small>
            <strong id="memory-center-title">记忆中心</strong>
            <p>短期保留当下上下文，长期沉淀稳定偏好与决定</p>
          </div>
          <span className="memory-center-count">
            <Sparkles size={14} />
            <b>{headerCount}</b> {headerCountLabel}
          </span>
          <button
            type="button"
            className="memory-center-close"
            onClick={onClose}
            aria-label="关闭记忆中心"
          >
            <X size={18} />
          </button>
        </header>

        <nav className="memory-center-tabs" role="tablist" aria-label="记忆分类">
          <button
            type="button"
            role="tab"
            aria-selected={view === "LONG_TERM"}
            className={view === "LONG_TERM" ? "is-active" : ""}
            onClick={() => selectView("LONG_TERM")}
          >
            <BrainCircuit size={15} /> 长期记忆
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "SHORT_TERM"}
            className={view === "SHORT_TERM" ? "is-active" : ""}
            onClick={() => selectView("SHORT_TERM")}
          >
            <TimerReset size={15} /> 7 天短期
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "CANDIDATES"}
            className={view === "CANDIDATES" ? "is-active" : ""}
            onClick={() => selectView("CANDIDATES")}
          >
            <Inbox size={15} /> 待确认
            {candidates.length > 0 && <b>{candidates.length}</b>}
          </button>
        </nav>

        {view === "CANDIDATES" ? (
          <CandidatePanel
            candidates={candidates}
            loading={candidatesLoading}
            error={candidatesError}
            busyIds={candidateBusyIds}
            settings={settings}
            settingsBusy={settingsBusy}
            onReload={loadCandidates}
            onToggleExplicitCapture={toggleExplicitCapture}
            onToggleSemanticCapture={toggleSemanticCapture}
            onHandle={handleCandidate}
            onOpenMessage={onOpenMessage}
          />
        ) : (
          <>
            <div className="memory-center-toolbar">
              <label className="memory-center-search">
                <Search size={16} />
                <input
                  ref={searchRef}
                  type="search"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={`搜索${tierLabel}`}
                  maxLength={100}
                  aria-label={`搜索${tierLabel}`}
                />
                {keyword && (
                  <button type="button" onClick={() => setKeyword("")} aria-label="清除记忆搜索">
                    <X size={14} />
                  </button>
                )}
              </label>
              <label className="memory-center-kind-filter">
                <span>类型</span>
                <select
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value as MemoryKind | "ALL")}
                  aria-label="按类型筛选记忆"
                >
                  <option value="ALL">全部</option>
                  {memoryKinds.map((kind) => (
                    <option value={kind.value} key={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="memory-search-mode" title="模型不可用时自动使用关键词检索">
                <Sparkles size={12} />
                {searchMode === "HYBRID" ? "语义增强" : "关键词"}
              </span>
              <button
                type="button"
                className="memory-center-new"
                onClick={startCreating}
                aria-label={`新建${tierLabel}`}
              >
                <Plus size={16} /> 新建记忆
              </button>
            </div>

            <div className="memory-center-body" role="tabpanel" aria-label={tierLabel}>
              <MemoryList
                memories={memories}
                selectedId={creating ? null : selectedId}
                tier={activeTier}
                loading={loading}
                error={loadError}
                searching={Boolean(debouncedKeyword)}
                onReload={loadMemories}
                onCreate={startCreating}
                onSelect={selectMemory}
              />
              <MemoryEditor
                creating={creating}
                memory={selectedMemory}
                draft={draft}
                tier={activeTier}
                dirty={dirty}
                saving={saving}
                saveError={saveError}
                forgetConfirm={forgetConfirm}
                onDraftChange={setDraft}
                onSave={saveMemory}
                onCreate={startCreating}
                onForgetIntent={setForgetConfirm}
                onForget={forgetSelectedMemory}
                onOpenMessage={onOpenMessage}
              />
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

interface MemoryListProps {
  memories: MemoryRecord[];
  selectedId: string | null;
  tier: MemoryTier;
  loading: boolean;
  error: string;
  searching: boolean;
  onReload: () => Promise<void>;
  onCreate: () => void;
  onSelect: (memory: MemoryRecord) => void;
}

function MemoryList({
  memories,
  selectedId,
  tier,
  loading,
  error,
  searching,
  onReload,
  onCreate,
  onSelect,
}: MemoryListProps) {
  const short = tier === "SHORT_TERM";
  const label = short ? "短期记忆" : "长期记忆";
  return (
    <aside className="memory-list" aria-label={`${label}列表`}>
      {loading ? (
        <div className="memory-center-state" role="status">
          <LoaderCircle className="spin" size={22} />
          <strong>正在整理记忆</strong>
          <span>只读取当前账号的私人内容</span>
        </div>
      ) : error ? (
        <div className="memory-center-state is-error" role="alert">
          <BrainCircuit size={23} />
          <strong>记忆暂时不可用</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void onReload()}>
            <RefreshCw size={14} /> 重新加载
          </button>
        </div>
      ) : memories.length === 0 ? (
        <div className="memory-center-state">
          <BrainCircuit size={24} />
          <strong>{searching ? "没有匹配的记忆" : `还没有${label}`}</strong>
          <span>
            {searching
              ? "换个关键词或类型试试"
              : short
                ? "记录本周需要持续关注的上下文，7 天后自动到期"
                : "先记下一条稳定信息，之后可持续修订"}
          </span>
          {!searching && (
            <button type="button" onClick={onCreate}>
              <Plus size={14} /> 创建第一条
            </button>
          )}
        </div>
      ) : (
        memories.map((memory) => (
          <button
            type="button"
            className={`memory-list-item ${selectedId === memory.id ? "is-active" : ""}`}
            key={memory.id}
            onClick={() => onSelect(memory)}
            aria-current={selectedId === memory.id ? "true" : undefined}
          >
            <span className="memory-list-item-topline">
              <em>{kindByValue.get(memory.kind)?.label ?? memory.kind}</em>
              <span aria-label={`重要程度 ${memory.importance} 级`}>
                {Array.from({ length: 5 }, (_, index) => (
                  <i className={index < memory.importance ? "is-on" : ""} key={index} />
                ))}
              </span>
            </span>
            <strong>{memory.title}</strong>
            <p>{memory.content}</p>
            <time dateTime={memory.updatedAt}>
              <Clock3 size={12} />
              {short && expiryLabel(memory.expiresAt)
                ? expiryLabel(memory.expiresAt)
                : formatMemoryTime(memory.updatedAt)}
            </time>
          </button>
        ))
      )}
    </aside>
  );
}

interface MemoryEditorProps {
  creating: boolean;
  memory: MemoryRecord | null;
  draft: MemoryDraft;
  tier: MemoryTier;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  forgetConfirm: boolean;
  onDraftChange: (draft: MemoryDraft) => void;
  onSave: () => Promise<void>;
  onCreate: () => void;
  onForgetIntent: (value: boolean) => void;
  onForget: () => Promise<void>;
  onOpenMessage?: (conversationId: string, messageId: string) => void;
}

function MemoryEditor(props: MemoryEditorProps) {
  const {
    creating,
    memory,
    draft,
    tier,
    dirty,
    saving,
    saveError,
    forgetConfirm,
    onDraftChange,
    onSave,
    onCreate,
    onForgetIntent,
    onForget,
    onOpenMessage,
  } = props;
  const short = tier === "SHORT_TERM";
  const label = short ? "短期记忆" : "长期记忆";
  const messageSource = memory?.sources.find(
    (source) => source.type === "MESSAGE" && source.id && source.conversationId,
  );
  if (!creating && !memory) {
    return (
      <section className="memory-editor" aria-label="记忆编辑器">
        <div className="memory-editor-empty">
          <span>{short ? <TimerReset size={28} /> : <BrainCircuit size={28} />}</span>
          <strong>选择或新建一条记忆</strong>
          <p>{short ? "临时上下文会在 7 天后自动到期" : "版本修订不会覆盖其他终端的新修改"}</p>
          <button type="button" onClick={onCreate}>
            <Plus size={14} /> 新建{label}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="memory-editor" aria-label="记忆编辑器">
      <header className="memory-editor-heading">
        <div>
          <small>{creating ? "NEW MEMORY" : `REVISION ${memory?.revision ?? 1}`}</small>
          <strong>{creating ? `新建${label}` : `编辑${label}`}</strong>
          <p>{kindByValue.get(draft.kind)?.detail}</p>
        </div>
        {!creating && memory && (
          <time dateTime={memory.updatedAt}>
            {short && expiryLabel(memory.expiresAt)
              ? expiryLabel(memory.expiresAt)
              : `更新于 ${formatMemoryTime(memory.updatedAt)}`}
          </time>
        )}
      </header>
      <div className="memory-editor-form">
        <label className="memory-editor-title">
          <span>标题</span>
          <input
            aria-label="标题"
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            placeholder={short ? "例如：本周发布重点" : "例如：NearChat 当前部署约定"}
            maxLength={120}
          />
          <small>{draft.title.length}/120</small>
        </label>
        <div className="memory-editor-meta">
          <label>
            <span>类型</span>
            <select
              value={draft.kind}
              onChange={(event) =>
                onDraftChange({ ...draft, kind: event.target.value as MemoryKind })
              }
            >
              {memoryKinds.map((kind) => (
                <option value={kind.value} key={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>重要程度</legend>
            <div className="memory-importance-picker">
              {[1, 2, 3, 4, 5].map((importance) => (
                <button
                  type="button"
                  className={draft.importance === importance ? "is-active" : ""}
                  aria-pressed={draft.importance === importance}
                  onClick={() => onDraftChange({ ...draft, importance })}
                  key={importance}
                >
                  {importance}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <label className="memory-editor-content">
          <span>记忆内容</span>
          <textarea
            aria-label="记忆内容"
            value={draft.content}
            onChange={(event) => onDraftChange({ ...draft, content: event.target.value })}
            placeholder={
              short
                ? "写下本周需要保持在上下文中的事项。创建后 7 天自动到期，也可以提前遗忘。"
                : "写清事实、背景和需要持续遵循的约定。之后可以修订，系统会保留版本轨迹。"
            }
            maxLength={10_000}
          />
          <small>{draft.content.length.toLocaleString("zh-CN")}/10,000</small>
        </label>
      </div>
      <footer className="memory-editor-footer">
        {!creating && messageSource && onOpenMessage ? (
          <button
            type="button"
            className="memory-source-note is-link"
            title={`定位到 ${messageSource.label}`}
            onClick={() => onOpenMessage(messageSource.conversationId!, messageSource.id!)}
            disabled={dirty || saving}
          >
            <ExternalLink size={13} /> 原消息 · {messageSource.label}
          </button>
        ) : (
          <span className="memory-source-note">
            {short ? <TimerReset size={14} /> : <Sparkles size={14} />}
            {creating
              ? short
                ? "保存后保留 7 天，仅当前账号可见"
                : "本条将标记为手动来源，仅当前账号可见"
              : `${memory?.sources[0]?.label ?? "手动创建"} · 版本 ${memory?.revision ?? 1}`}
          </span>
        )}
        {saveError && (
          <span className="memory-save-error" role="alert">
            {saveError}
          </span>
        )}
        <div>
          {!creating &&
            memory &&
            (forgetConfirm ? (
              <span className="memory-forget-confirm">
                <button type="button" onClick={() => onForgetIntent(false)} disabled={saving}>
                  取消
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => void onForget()}
                  disabled={saving}
                >
                  {saving ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                  确认遗忘
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="memory-forget-button"
                onClick={() => onForgetIntent(true)}
              >
                <Trash2 size={14} /> 遗忘
              </button>
            ))}
          <button
            type="button"
            className="memory-save-button"
            disabled={!dirty || !draft.title.trim() || !draft.content.trim() || saving}
            onClick={() => void onSave()}
          >
            {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
            {creating ? "保存记忆" : "保存修改"}
          </button>
        </div>
      </footer>
    </section>
  );
}

interface CandidatePanelProps {
  candidates: MemoryCandidate[];
  loading: boolean;
  error: string;
  busyIds: ReadonlySet<string>;
  settings: MemorySettings | null;
  settingsBusy: "EXPLICIT" | "SEMANTIC" | null;
  onReload: () => Promise<void>;
  onToggleExplicitCapture: () => Promise<void>;
  onToggleSemanticCapture: () => Promise<void>;
  onHandle: (candidate: MemoryCandidate, action: "REJECT" | MemoryTier) => Promise<void>;
  onOpenMessage?: (conversationId: string, messageId: string) => void;
}

function CandidatePanel(props: CandidatePanelProps) {
  const { candidates, loading, error, busyIds, settings, settingsBusy } = props;
  return (
    <>
      <div className="memory-candidate-toolbar">
        <div>
          <strong>确认后才会进入你的记忆</strong>
          <span>消息快照仅当前账号可见，不会改变或复制原附件</span>
        </div>
        <div className="memory-capture-settings">
          <label className="memory-capture-setting">
            <span>
              <b>识别“记住…”</b>
              <small>纯规则，不调用模型</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.explicitCaptureEnabled ?? true}
              aria-label="自动识别明确记忆意图"
              className={settings?.explicitCaptureEnabled !== false ? "is-on" : ""}
              onClick={() => void props.onToggleExplicitCapture()}
              disabled={!settings || Boolean(settingsBusy)}
            >
              {settingsBusy === "EXPLICIT" && <LoaderCircle className="spin" size={11} />}
              <i />
            </button>
          </label>
          <label className="memory-capture-setting is-semantic">
            <span>
              <b>智能整理近期会话</b>
              <small>
                {settings
                  ? `${settings.semanticCaptureMessageThreshold} 条或静默 ${settings.semanticCaptureSilenceMinutes} 分钟 · 需 AI`
                  : "按批次后台运行 · 需 AI"}
              </small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.semanticCaptureEnabled ?? false}
              aria-label="智能整理近期会话"
              className={settings?.semanticCaptureEnabled ? "is-on" : ""}
              onClick={() => void props.onToggleSemanticCapture()}
              disabled={!settings || Boolean(settingsBusy)}
            >
              {settingsBusy === "SEMANTIC" && <LoaderCircle className="spin" size={11} />}
              <i />
            </button>
          </label>
        </div>
      </div>
      <section className="memory-candidate-board" role="tabpanel" aria-label="待确认记忆">
        {loading ? (
          <div className="memory-center-state" role="status">
            <LoaderCircle className="spin" size={22} />
            <strong>正在整理候选</strong>
            <span>只读取当前账号主动标记的消息</span>
          </div>
        ) : error ? (
          <div className="memory-center-state is-error" role="alert">
            <Inbox size={23} />
            <strong>候选暂时不可用</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void props.onReload()}>
              <RefreshCw size={14} /> 重新加载
            </button>
          </div>
        ) : candidates.length === 0 ? (
          <div className="memory-center-state memory-candidate-empty">
            <span className="memory-candidate-empty-icon">
              <Check size={22} />
            </span>
            <strong>候选箱已清空</strong>
            <span>把鼠标移到聊天消息上，点击脑形图标即可加入这里</span>
          </div>
        ) : (
          <div className="memory-candidate-grid">
            {candidates.map((candidate) => {
              const busy = busyIds.has(candidate.id);
              return (
                <article className="memory-candidate-card" key={candidate.id}>
                  <header>
                    <em>{kindByValue.get(candidate.kind)?.label ?? candidate.kind}</em>
                    <time dateTime={candidate.createdAt}>
                      {formatMemoryTime(candidate.createdAt)}
                    </time>
                  </header>
                  <strong>{candidate.title}</strong>
                  <p>{candidate.content}</p>
                  {candidate.source.id && candidate.source.conversationId && props.onOpenMessage ? (
                    <button
                      type="button"
                      className="memory-candidate-source is-link"
                      onClick={() =>
                        props.onOpenMessage!(candidate.source.conversationId!, candidate.source.id!)
                      }
                    >
                      <ExternalLink size={12} /> 原消息 · {candidate.source.label}
                    </button>
                  ) : (
                    <span className="memory-candidate-source">
                      <Inbox size={12} /> {candidate.source.label}
                    </span>
                  )}
                  <footer>
                    <button
                      type="button"
                      className="memory-candidate-reject"
                      onClick={() => void props.onHandle(candidate, "REJECT")}
                      disabled={busy}
                    >
                      忽略
                    </button>
                    <button
                      type="button"
                      onClick={() => void props.onHandle(candidate, "SHORT_TERM")}
                      disabled={busy}
                    >
                      <TimerReset size={14} /> 保留 7 天
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => void props.onHandle(candidate, "LONG_TERM")}
                      disabled={busy}
                    >
                      {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                      转为长期
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
