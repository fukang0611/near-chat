import { FormEvent, useEffect, useState } from "react";
import type { PersonalRecord } from "../models";
import { listEntities, removeLocalEntity, saveLocalEntity, searchEntities } from "../native";

const now = () => new Date().toISOString();

interface Props {
  accountKey: string;
  refreshVersion: number;
  onChanged(): void;
}

export function RecordsSection({ accountKey, refreshVersion, onChanged }: Props) {
  const [records, setRecords] = useState<PersonalRecord[]>([]);
  const [visible, setVisible] = useState<PersonalRecord[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<PersonalRecord | null>(null);

  const reload = async () => {
    const next = await listEntities(accountKey, "PERSONAL_RECORD");
    setRecords(next);
    setVisible(next);
  };

  useEffect(() => {
    void reload();
  }, [accountKey, refreshVersion]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!query.trim()) return setVisible(records);
      void searchEntities(accountKey, query, ["PERSONAL_RECORD"], 100).then((results) =>
        setVisible(results.map(({ entity }) => entity as PersonalRecord)),
      );
    }, 180);
    return () => window.clearTimeout(handle);
  }, [accountKey, query, records]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const content = String(form.get("content") ?? "").trim();
    if (!title || !content) return;
    const timestamp = now();
    const record: PersonalRecord = editing
      ? { ...editing, title, content, updatedAt: timestamp }
      : {
          id: crypto.randomUUID(),
          title,
          content,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    await saveLocalEntity(accountKey, "PERSONAL_RECORD", record);
    setEditing(null);
    event.currentTarget.reset();
    await reload();
    onChanged();
  };

  const remove = async (record: PersonalRecord) => {
    await removeLocalEntity(
      accountKey,
      "PERSONAL_RECORD",
      record.id,
      record.revision > 0 ? record.revision : null,
    );
    if (editing?.id === record.id) setEditing(null);
    await reload();
    onChanged();
  };

  return (
    <section>
      <div>
        <h1>个人记录</h1>
        <small>Markdown 原文保存在本机，可离线全文检索。</small>
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索记录"
      />
      <form key={editing?.id ?? "new"} onSubmit={save}>
        <input
          name="title"
          defaultValue={editing?.title ?? ""}
          placeholder="标题"
          maxLength={160}
          required
        />
        <textarea
          name="content"
          defaultValue={editing?.content ?? ""}
          placeholder="Markdown 记录"
          maxLength={20000}
          required
        />
        <div className="button-row">
          <button>{editing ? "保存修改" : "保存记录"}</button>
          {editing && (
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              取消
            </button>
          )}
        </div>
      </form>
      {visible.length === 0 && <p className="empty">没有匹配的记录。</p>}
      {visible.map((record) => (
        <article key={record.id}>
          <div>
            <strong>{record.title}</strong>
            <p>{record.content}</p>
          </div>
          <div className="article-actions">
            <button className="secondary" onClick={() => setEditing(record)}>
              编辑
            </button>
            <button className="danger" onClick={() => void remove(record)}>
              删除
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
