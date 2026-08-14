import {
  Archive,
  ArchiveRestore,
  Check,
  Eye,
  EyeOff,
  MessageSquarePlus,
  Pencil,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { AiAssistantThread } from "../types";

interface AssistantThreadBarProps {
  threads: AiAssistantThread[];
  selectedId: string | null;
  loading: boolean;
  busyId: string | null;
  showArchived: boolean;
  onSelect: (threadId: string) => void;
  onCreate: (title: string) => Promise<boolean>;
  onRename: (threadId: string, title: string) => Promise<boolean>;
  onToggleArchived: (thread: AiAssistantThread) => Promise<void>;
  onToggleShowArchived: () => void;
}

type EditorState =
  { mode: "create"; value: string } | { mode: "rename"; threadId: string; value: string } | null;

/**
 * 线程栏只处理轻量导航和就地命名；消息、草稿和模型上下文仍由工作区按 threadId 隔离。
 */
export function AssistantThreadBar({
  threads,
  selectedId,
  loading,
  busyId,
  showArchived,
  onSelect,
  onCreate,
  onRename,
  onToggleArchived,
  onToggleShowArchived,
}: AssistantThreadBarProps) {
  const [editor, setEditor] = useState<EditorState>(null);
  const activeCount = threads.filter((thread) => !thread.archived).length;

  useEffect(() => setEditor(null), [selectedId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor || busyId) return;
    const title = editor.value.trim();
    if (!title) return;
    const saved =
      editor.mode === "create" ? await onCreate(title) : await onRename(editor.threadId, title);
    if (saved) setEditor(null);
  }

  return (
    <div className="assistant-thread-bar">
      <div className="assistant-thread-scroll" role="tablist" aria-label="助理对话线程">
        {loading ? (
          <span className="assistant-thread-loading">正在读取对话</span>
        ) : (
          threads.map((thread) => (
            <div
              className={`assistant-thread-chip ${thread.id === selectedId ? "is-active" : ""} ${thread.archived ? "is-archived" : ""}`}
              key={thread.id}
            >
              <button
                type="button"
                role="tab"
                aria-selected={thread.id === selectedId}
                onClick={() => onSelect(thread.id)}
              >
                <span>{thread.title}</span>
                {thread.messageCount > 0 && <small>{thread.messageCount}</small>}
              </button>
              {thread.id === selectedId && !thread.archived && (
                <button
                  type="button"
                  className="is-action"
                  aria-label={`重命名 ${thread.title}`}
                  title="重命名"
                  onClick={() =>
                    setEditor({ mode: "rename", threadId: thread.id, value: thread.title })
                  }
                >
                  <Pencil size={11} />
                </button>
              )}
              {thread.id === selectedId && (
                <button
                  type="button"
                  className="is-action"
                  aria-label={thread.archived ? `恢复 ${thread.title}` : `归档 ${thread.title}`}
                  title={
                    thread.archived
                      ? "恢复对话"
                      : activeCount <= 1
                        ? "至少保留一条未归档对话"
                        : "归档对话并暂停其中的自动任务"
                  }
                  disabled={Boolean(busyId) || (!thread.archived && activeCount <= 1)}
                  onClick={() => void onToggleArchived(thread)}
                >
                  {thread.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="assistant-thread-controls">
        <button
          type="button"
          onClick={() => setEditor({ mode: "create", value: "" })}
          aria-label="新建助理对话"
          title="新建对话"
          disabled={Boolean(busyId)}
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          type="button"
          className={showArchived ? "is-active" : ""}
          onClick={onToggleShowArchived}
          aria-label={showArchived ? "隐藏已归档对话" : "显示已归档对话"}
          title={showArchived ? "隐藏已归档" : "显示已归档"}
        >
          {showArchived ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {editor && (
        <form className="assistant-thread-editor" onSubmit={(event) => void submit(event)}>
          <MessageSquarePlus size={14} />
          <input
            value={editor.value}
            onChange={(event) => setEditor({ ...editor, value: event.target.value })}
            placeholder={editor.mode === "create" ? "新对话名称" : "对话名称"}
            aria-label={editor.mode === "create" ? "新对话名称" : "重命名对话"}
            maxLength={80}
            autoFocus
          />
          <button
            type="submit"
            aria-label="保存对话名称"
            disabled={!editor.value.trim() || !!busyId}
          >
            <Check size={13} />
          </button>
          <button type="button" aria-label="取消编辑对话" onClick={() => setEditor(null)}>
            <X size={13} />
          </button>
        </form>
      )}
    </div>
  );
}
