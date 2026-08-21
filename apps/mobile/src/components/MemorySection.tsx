import { FormEvent, useEffect, useState } from "react";
import type { LocalMemory } from "../models";
import {
  expiresAtForMemory,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  validateMemoryDraft,
} from "../entity-limits";
import { listEntities, removeLocalEntity, saveLocalEntity, searchEntities } from "../native";

const now = () => new Date().toISOString();

interface Props {
  accountKey: string;
  refreshVersion: number;
  onChanged(): void;
}

export function MemorySection({ accountKey, refreshVersion, onChanged }: Props) {
  const [memories, setMemories] = useState<LocalMemory[]>([]);
  const [visible, setVisible] = useState<LocalMemory[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<LocalMemory | null>(null);
  const [error, setError] = useState("");

  const reload = async () => {
    const next = await listEntities(accountKey, "MEMORY");
    setMemories(next);
    setVisible(next);
  };

  useEffect(() => {
    void reload();
  }, [accountKey, refreshVersion]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!query.trim()) return setVisible(memories);
      void searchEntities(accountKey, query, ["MEMORY"], 100).then((results) =>
        setVisible(results.map(({ entity }) => entity as LocalMemory)),
      );
    }, 180);
    return () => window.clearTimeout(handle);
  }, [accountKey, memories, query]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const content = String(form.get("content") ?? "").trim();
    const validationError = validateMemoryDraft(title, content);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    const timestamp = now();
    const tier = form.get("tier") === "SHORT_TERM" ? "SHORT_TERM" : "LONG_TERM";
    const expiresAt = expiresAtForMemory(
      tier,
      editing?.tier === "SHORT_TERM" ? editing.expiresAt : null,
      Date.parse(timestamp),
    );
    const memory: LocalMemory = editing
      ? {
          ...editing,
          title,
          content,
          tier,
          importance: Math.min(
            5,
            Math.max(1, Number(form.get("importance") ?? editing.importance) || 3),
          ),
          updatedAt: timestamp,
          expiresAt,
        }
      : {
          id: crypto.randomUUID(),
          tier,
          scope: "PRIVATE",
          conversationId: null,
          kind: "NOTE",
          title,
          content,
          importance: Math.min(5, Math.max(1, Number(form.get("importance") ?? 3) || 3)),
          status: "ACTIVE",
          revision: 0,
          expiresAt,
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        };
    await saveLocalEntity(accountKey, "MEMORY", memory);
    setEditing(null);
    event.currentTarget.reset();
    await reload();
    onChanged();
  };

  const remove = async (memory: LocalMemory) => {
    await removeLocalEntity(
      accountKey,
      "MEMORY",
      memory.id,
      memory.revision > 0 ? memory.revision : null,
    );
    if (editing?.id === memory.id) setEditing(null);
    await reload();
    onChanged();
  };

  return (
    <section>
      <div>
        <h1>本地记忆</h1>
        <small>Room FTS 离线搜索；模型不可用也不影响增删改查。</small>
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索标题或内容"
        aria-label="搜索本地记忆"
      />
      <form key={editing?.id ?? "new"} onSubmit={save}>
        <input
          name="title"
          defaultValue={editing?.title ?? ""}
          placeholder="记忆标题"
          maxLength={MEMORY_TITLE_MAX}
          required
        />
        <textarea
          name="content"
          defaultValue={editing?.content ?? ""}
          placeholder="记忆内容"
          maxLength={MEMORY_CONTENT_MAX}
          required
        />
        <div className="field-row">
          <label>
            类型
            <select name="tier" defaultValue={editing?.tier ?? "LONG_TERM"}>
              <option value="LONG_TERM">长期</option>
              <option value="SHORT_TERM">短期</option>
            </select>
            <small>短期记忆默认 7 天后到期</small>
          </label>
          <label>
            重要度
            <input
              name="importance"
              type="number"
              min="1"
              max="5"
              defaultValue={editing?.importance ?? 3}
              required
            />
          </label>
        </div>
        {error && <small className="error-text">{error}</small>}
        <div className="button-row">
          <button>{editing ? "保存修改" : "新增记忆"}</button>
          {editing && (
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              取消
            </button>
          )}
        </div>
      </form>
      {visible.length === 0 && <p className="empty">没有匹配的本地记忆。</p>}
      {visible.map((memory) => (
        <article key={memory.id}>
          <div>
            <strong>{memory.title}</strong>
            <small>
              {memory.tier === "LONG_TERM" ? "长期记忆" : "短期记忆"} · 重要度 {memory.importance}
            </small>
            {memory.expiresAt && <small>到期 {new Date(memory.expiresAt).toLocaleString()}</small>}
            <p>{memory.content}</p>
          </div>
          <div className="article-actions">
            <button className="secondary" onClick={() => setEditing(memory)}>
              编辑
            </button>
            <button className="danger" onClick={() => void remove(memory)}>
              删除
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
