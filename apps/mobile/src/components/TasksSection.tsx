import { FormEvent, useEffect, useMemo, useState } from "react";
import type { PersonalReminder, PersonalTask } from "../models";
import {
  cancelThenMutateReminder,
  reconcileCurrentReminder,
  reconcileCurrentReminderAccount,
} from "../reminder-reconcile";
import {
  listEntities,
  removeLocalEntity,
  removeLocalEntityInMutation,
  saveLocalEntity,
} from "../native";

const now = () => new Date().toISOString();

function fromLocalInput(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface Props {
  accountKey: string;
  refreshVersion: number;
  onChanged(): void;
  isAccountActive(): boolean;
}

export function TasksSection({ accountKey, refreshVersion, onChanged, isAccountActive }: Props) {
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [reminders, setReminders] = useState<PersonalReminder[]>([]);
  const [editingReminder, setEditingReminder] = useState<PersonalReminder | null>(null);
  const [notificationMessage, setNotificationMessage] = useState("");

  const notificationEffect = async <T,>(effect: () => Promise<T>): Promise<T | null> => {
    try {
      return await effect();
    } catch (error) {
      if (!isAccountActive()) return null;
      throw error;
    }
  };

  const reload = async () => {
    const [nextTasks, nextReminders] = await Promise.all([
      listEntities(accountKey, "PERSONAL_TASK"),
      listEntities(accountKey, "PERSONAL_REMINDER"),
    ]);
    if (!isAccountActive()) return;
    setTasks(nextTasks);
    setReminders(nextReminders);
    await notificationEffect(() => reconcileCurrentReminderAccount(accountKey, isAccountActive));
  };

  useEffect(() => {
    void reload();
  }, [accountKey, refreshVersion]);

  const pendingTasks = useMemo(() => tasks.filter((task) => !task.completedAt), [tasks]);

  const addTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    const timestamp = now();
    const task: PersonalTask = {
      id: crypto.randomUUID(),
      title,
      note: String(form.get("note") ?? "").trim(),
      dueAt: fromLocalInput(form.get("dueAt")),
      completedAt: null,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await saveLocalEntity(accountKey, "PERSONAL_TASK", task);
    event.currentTarget.reset();
    await reload();
    onChanged();
  };

  const completeTask = async (task: PersonalTask) => {
    if (task.completedAt) return;
    await saveLocalEntity(accountKey, "PERSONAL_TASK", {
      ...task,
      completedAt: now(),
      updatedAt: now(),
    });
    await reload();
    onChanged();
  };

  const deleteTask = async (task: PersonalTask) => {
    await removeLocalEntity(
      accountKey,
      "PERSONAL_TASK",
      task.id,
      task.revision > 0 ? task.revision : null,
    );
    await reload();
    onChanged();
  };

  const saveReminder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const scheduledAt = fromLocalInput(form.get("scheduledAt"));
    if (!title || !scheduledAt) return;
    const timestamp = now();
    const reminder: PersonalReminder = editingReminder
      ? {
          ...editingReminder,
          title,
          note: String(form.get("note") ?? "").trim(),
          scheduledAt,
          notifiedAt:
            editingReminder.scheduledAt === scheduledAt ? editingReminder.notifiedAt : null,
          updatedAt: timestamp,
        }
      : {
          id: crypto.randomUUID(),
          title,
          note: String(form.get("note") ?? "").trim(),
          scheduledAt,
          completedAt: null,
          notifiedAt: null,
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    await saveLocalEntity(accountKey, "PERSONAL_REMINDER", reminder);
    const scheduled = await notificationEffect(() =>
      reconcileCurrentReminder(accountKey, reminder.id, isAccountActive),
    );
    if (!isAccountActive()) return;
    setNotificationMessage(
      scheduled ? "系统通知已安排" : "提醒已保存；请允许通知权限并确保时间晚于当前时间",
    );
    setEditingReminder(null);
    event.currentTarget.reset();
    await reload();
    onChanged();
  };

  const completeReminder = async (reminder: PersonalReminder) => {
    if (reminder.completedAt) return;
    await saveLocalEntity(accountKey, "PERSONAL_REMINDER", {
      ...reminder,
      completedAt: now(),
      updatedAt: now(),
    });
    await notificationEffect(() =>
      reconcileCurrentReminder(accountKey, reminder.id, isAccountActive),
    );
    await reload();
    onChanged();
  };

  const deleteReminder = async (reminder: PersonalReminder) => {
    // 先撤销稳定通知 ID；取消失败时保留 Room 行，启动后仍可枚举并重试。
    await notificationEffect(() =>
      cancelThenMutateReminder(accountKey, reminder.id, (effectiveAccountKey) =>
        removeLocalEntityInMutation(
          effectiveAccountKey,
          "PERSONAL_REMINDER",
          reminder.id,
          reminder.revision > 0 ? reminder.revision : null,
        ),
      ),
    );
    if (editingReminder?.id === reminder.id) setEditingReminder(null);
    await reload();
    onChanged();
  };

  return (
    <section>
      <div>
        <h1>任务与提醒</h1>
        <small>完全离线可编辑；提醒由 Android 系统调度。</small>
      </div>
      <h2>个人任务 · 待完成 {pendingTasks.length}</h2>
      <form onSubmit={addTask}>
        <input name="title" placeholder="要完成什么？" maxLength={160} required />
        <textarea name="note" placeholder="补充说明（可选）" maxLength={4000} />
        <label>
          截止时间
          <input name="dueAt" type="datetime-local" />
        </label>
        <button>新增任务</button>
      </form>
      {tasks.map((task) => (
        <article key={task.id}>
          <div>
            <strong>{task.title}</strong>
            <p>{task.note || "无补充说明"}</p>
            {task.dueAt && <small>截止 {new Date(task.dueAt).toLocaleString()}</small>}
          </div>
          <div className="article-actions">
            <button disabled={Boolean(task.completedAt)} onClick={() => void completeTask(task)}>
              {task.completedAt ? "已完成" : "完成"}
            </button>
            <button className="danger" onClick={() => void deleteTask(task)}>
              删除
            </button>
          </div>
        </article>
      ))}

      <h2>本地提醒</h2>
      <form key={editingReminder?.id ?? "new"} onSubmit={saveReminder}>
        <input
          name="title"
          defaultValue={editingReminder?.title ?? ""}
          placeholder="提醒标题"
          maxLength={160}
          required
        />
        <textarea
          name="note"
          defaultValue={editingReminder?.note ?? ""}
          placeholder="提醒说明（可选）"
          maxLength={4000}
        />
        <label>
          提醒时间
          <input
            name="scheduledAt"
            type="datetime-local"
            defaultValue={toLocalInput(editingReminder?.scheduledAt ?? null)}
            required
          />
        </label>
        <div className="button-row">
          <button>{editingReminder ? "保存提醒" : "新增提醒"}</button>
          {editingReminder && (
            <button type="button" className="secondary" onClick={() => setEditingReminder(null)}>
              取消
            </button>
          )}
        </div>
        {notificationMessage && <small>{notificationMessage}</small>}
      </form>
      {reminders.map((reminder) => (
        <article key={reminder.id}>
          <div>
            <strong>{reminder.title}</strong>
            <p>{reminder.note || "无补充说明"}</p>
            <small>{new Date(reminder.scheduledAt).toLocaleString()}</small>
          </div>
          <div className="article-actions">
            <button className="secondary" onClick={() => setEditingReminder(reminder)}>
              编辑
            </button>
            <button
              disabled={Boolean(reminder.completedAt)}
              onClick={() => void completeReminder(reminder)}
            >
              {reminder.completedAt ? "已完成" : "完成"}
            </button>
            <button className="danger" onClick={() => void deleteReminder(reminder)}>
              删除
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
