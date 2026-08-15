import type { MemoryKind, MemoryRecord } from "@near-chat/contracts";
import {
  BrainCircuit,
  Clock3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
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
}

interface MemoryDraft {
  title: string;
  content: string;
  kind: MemoryKind;
  importance: number;
}

const memoryKinds: Array<{ value: MemoryKind; label: string; detail: string }> = [
  { value: "NOTE", label: "备忘", detail: "需要长期保留的信息" },
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

/**
 * 私人长期记忆的第一版管理界面。它只调用原生记忆接口，不依赖 AI 能力状态，
 * 因此管理员关闭模型后仍可创建、检索、修订和遗忘内容。
 */
export function MemoryCenterDialog({ onClose, onNotify }: MemoryCenterDialogProps) {
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKind | "ALL">("ALL");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const requestIdRef = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

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
        limit: 200,
      });
      if (requestId !== requestIdRef.current) return;
      setMemories(page.memories);
      setTotal(page.total);
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
  }, [debouncedKeyword, kindFilter]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  useEffect(() => {
    if (!creating && selectedMemory) setDraft(memoryDraft(selectedMemory));
    setSaveError("");
    setForgetConfirm(false);
  }, [creating, selectedMemory]);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, saving]);

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
    };
    if (!input.title || !input.content || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      if (creating) {
        const { memory } = await api.createMemory(input);
        // 新记忆可能不符合当前筛选条件；保存后回到完整列表，避免刚创建的内容
        // 立即从用户视野中消失。
        setKeyword("");
        setDebouncedKeyword("");
        setKindFilter("ALL");
        setMemories((current) => [memory, ...current.filter((item) => item.id !== memory.id)]);
        setTotal((current) => current + 1);
        setSelectedId(memory.id);
        setCreating(false);
        setDraft(memoryDraft(memory));
        onNotify?.("已保存到长期记忆", "success");
      } else if (selectedMemory) {
        const { memory } = await api.updateMemory(selectedMemory.id, {
          ...input,
          baseRevision: selectedMemory.revision,
        });
        setMemories((current) => current.map((item) => (item.id === memory.id ? memory : item)));
        setDraft(memoryDraft(memory));
        onNotify?.("记忆已更新", "success");
      }
    } catch (saveFailure) {
      const message = errorMessage(saveFailure, "记忆保存失败");
      setSaveError(message);
      if (saveFailure instanceof ApiError && saveFailure.status === 409) {
        await loadMemories();
      }
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

  const formVisible = creating || Boolean(selectedMemory);

  return createPortal(
    <div
      className="memory-center-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
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
            <p>整理值得长期保留的背景、偏好与决定</p>
          </div>
          <span className="memory-center-count">
            <Sparkles size={14} />
            <b>{total}</b> 条长期记忆
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

        <div className="memory-center-toolbar">
          <label className="memory-center-search">
            <Search size={16} />
            <input
              ref={searchRef}
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索标题或内容"
              maxLength={100}
              aria-label="搜索长期记忆"
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
          <button
            type="button"
            className="memory-center-new"
            onClick={startCreating}
            aria-label="新建长期记忆"
          >
            <Plus size={16} />
            新建记忆
          </button>
        </div>

        <div className="memory-center-body">
          <aside className="memory-list" aria-label="长期记忆列表">
            {loading ? (
              <div className="memory-center-state" role="status">
                <LoaderCircle className="spin" size={22} />
                <strong>正在整理记忆</strong>
                <span>只读取当前账号的私人内容</span>
              </div>
            ) : loadError ? (
              <div className="memory-center-state is-error" role="alert">
                <BrainCircuit size={23} />
                <strong>记忆暂时不可用</strong>
                <span>{loadError}</span>
                <button type="button" onClick={() => void loadMemories()}>
                  <RefreshCw size={14} />
                  重新加载
                </button>
              </div>
            ) : memories.length === 0 ? (
              <div className="memory-center-state">
                <BrainCircuit size={24} />
                <strong>{debouncedKeyword ? "没有匹配的记忆" : "还没有长期记忆"}</strong>
                <span>
                  {debouncedKeyword ? "换个关键词或类型试试" : "先记下一条稳定信息，之后可持续修订"}
                </span>
                {!debouncedKeyword && (
                  <button type="button" onClick={startCreating}>
                    <Plus size={14} />
                    创建第一条
                  </button>
                )}
              </div>
            ) : (
              memories.map((memory) => (
                <button
                  type="button"
                  className={`memory-list-item ${!creating && selectedId === memory.id ? "is-active" : ""}`}
                  key={memory.id}
                  onClick={() => selectMemory(memory)}
                  aria-current={!creating && selectedId === memory.id ? "true" : undefined}
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
                    {formatMemoryTime(memory.updatedAt)}
                  </time>
                </button>
              ))
            )}
          </aside>

          <section className="memory-editor" aria-label="记忆编辑器">
            {formVisible ? (
              <>
                <header className="memory-editor-heading">
                  <div>
                    <small>
                      {creating ? "NEW MEMORY" : `REVISION ${selectedMemory?.revision ?? 1}`}
                    </small>
                    <strong>{creating ? "新建长期记忆" : "编辑长期记忆"}</strong>
                    <p>{kindByValue.get(draft.kind)?.detail}</p>
                  </div>
                  {!creating && selectedMemory && (
                    <time dateTime={selectedMemory.updatedAt}>
                      更新于 {formatMemoryTime(selectedMemory.updatedAt)}
                    </time>
                  )}
                </header>

                <div className="memory-editor-form">
                  <label className="memory-editor-title">
                    <span>标题</span>
                    <input
                      aria-label="标题"
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, title: event.target.value }))
                      }
                      placeholder="例如：NearChat 当前部署约定"
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
                          setDraft((current) => ({
                            ...current,
                            kind: event.target.value as MemoryKind,
                          }))
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
                            onClick={() => setDraft((current) => ({ ...current, importance }))}
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
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, content: event.target.value }))
                      }
                      placeholder="写清事实、背景和需要持续遵循的约定。之后可以修订，系统会保留版本轨迹。"
                      maxLength={10_000}
                    />
                    <small>{draft.content.length.toLocaleString("zh-CN")}/10,000</small>
                  </label>
                </div>

                <footer className="memory-editor-footer">
                  <span className="memory-source-note">
                    <Sparkles size={14} />
                    {creating
                      ? "本条将标记为手动来源，仅当前账号可见"
                      : `${selectedMemory?.sources[0]?.label ?? "手动创建"} · 版本 ${selectedMemory?.revision ?? 1}`}
                  </span>
                  {saveError && (
                    <span className="memory-save-error" role="alert">
                      {saveError}
                    </span>
                  )}
                  <div>
                    {!creating &&
                      selectedMemory &&
                      (forgetConfirm ? (
                        <span className="memory-forget-confirm">
                          <button
                            type="button"
                            onClick={() => setForgetConfirm(false)}
                            disabled={saving}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            onClick={() => void forgetSelectedMemory()}
                            disabled={saving}
                          >
                            {saving ? (
                              <LoaderCircle className="spin" size={14} />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            确认遗忘
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="memory-forget-button"
                          onClick={() => setForgetConfirm(true)}
                        >
                          <Trash2 size={14} />
                          遗忘
                        </button>
                      ))}
                    <button
                      type="button"
                      className="memory-save-button"
                      disabled={!dirty || !draft.title.trim() || !draft.content.trim() || saving}
                      onClick={() => void saveMemory()}
                    >
                      {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
                      {creating ? "保存记忆" : "保存修改"}
                    </button>
                  </div>
                </footer>
              </>
            ) : (
              <div className="memory-editor-empty">
                <span>
                  <BrainCircuit size={28} />
                </span>
                <strong>选择或新建一条记忆</strong>
                <p>长期记忆可以持续修订，也可以随时要求系统遗忘。</p>
                <button type="button" onClick={startCreating}>
                  <Plus size={15} />
                  新建记忆
                </button>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}
