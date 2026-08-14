import {
  AlarmClock,
  Bell,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  List,
  LoaderCircle,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, type SaveAiAssistantReminderInput } from "../api";
import type {
  AiAssistant,
  AiAssistantReminder,
  AiAssistantTask,
  AiAssistantThread,
} from "../types";
import { errorMessage } from "../utils/errors";

interface AssistantSchedulePanelProps {
  assistant: AiAssistant;
  threads: AiAssistantThread[];
  selectedThreadId: string;
  refreshVersion: number;
  onNotice: (tone: "error" | "success", text: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenTask: (threadId: string) => void;
}

interface ReminderForm {
  title: string;
  note: string;
  scheduledAt: string;
  threadId: string;
}

interface ScheduleEntry {
  id: string;
  kind: "TASK" | "REMINDER";
  at: string;
  title: string;
  threadId: string;
  threadTitle: string;
  tone: "active" | "due" | "paused" | "completed";
  task?: AiAssistantTask;
  reminder?: AiAssistantReminder;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function localDateTime(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function emptyReminderForm(threadId: string): ReminderForm {
  const scheduledAt = new Date(Date.now() + 30 * 60_000);
  scheduledAt.setSeconds(0, 0);
  return { title: "", note: "", scheduledAt: localDateTime(scheduledAt), threadId };
}

function localDateKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatScheduleTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDayTitle(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(year!, month! - 1, day));
}

function taskTone(task: AiAssistantTask): ScheduleEntry["tone"] {
  if (!task.enabled && !task.nextRunAt && task.lastStatus === "SUCCEEDED") return "completed";
  if (!task.enabled) return "paused";
  return "active";
}

function taskScheduleLabel(task: AiAssistantTask): string {
  if (task.scheduleType === "DAILY") return "每天";
  if (task.scheduleType === "WEEKLY") return "每周";
  return "一次";
}

/**
 * 日程中心只汇总确定的下一次时间：周期任务不在前端猜测未来所有实例，提醒也以服务端
 * 状态为准，从而避免时区、停机和推迟操作造成重复事件。
 */
export function AssistantSchedulePanel({
  assistant,
  threads,
  selectedThreadId,
  refreshVersion,
  onNotice,
  onOpenThread,
  onOpenTask,
}: AssistantSchedulePanelProps) {
  const [tasks, setTasks] = useState<AiAssistantTask[]>([]);
  const [reminders, setReminders] = useState<AiAssistantReminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"agenda" | "calendar">("agenda");
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth()),
  );
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(new Date()));
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<ReminderForm>(() => emptyReminderForm(selectedThreadId));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.aiAssistantSchedule(assistant.id);
      setTasks(result.tasks);
      setReminders(result.reminders);
    } catch (error) {
      onNotice("error", errorMessage(error, "日程加载失败"));
    } finally {
      setLoading(false);
    }
  }, [assistant.id, onNotice]);

  useEffect(() => {
    setEditorOpen(false);
    setConfirmDeleteId(null);
    void loadSchedule();
  }, [loadSchedule, refreshVersion]);

  useEffect(() => {
    if (!editorOpen) setForm(emptyReminderForm(selectedThreadId));
  }, [editorOpen, selectedThreadId]);

  const threadTitles = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.title])),
    [threads],
  );
  const entries = useMemo<ScheduleEntry[]>(() => {
    const taskEntries = tasks
      .filter((task) => task.nextRunAt || task.lastRunAt)
      .map((task) => ({
        id: `task:${task.id}`,
        kind: "TASK" as const,
        at: task.nextRunAt ?? task.lastRunAt!,
        title: task.title,
        threadId: task.threadId,
        threadTitle: threadTitles.get(task.threadId) ?? "已归档对话",
        tone: taskTone(task),
        task,
      }));
    const reminderEntries = reminders.map((reminder) => ({
      id: `reminder:${reminder.id}`,
      kind: "REMINDER" as const,
      at: reminder.scheduledAt,
      title: reminder.title,
      threadId: reminder.threadId,
      threadTitle: reminder.threadTitle,
      tone:
        reminder.status === "COMPLETED"
          ? ("completed" as const)
          : reminder.status === "DUE"
            ? ("due" as const)
            : ("active" as const),
      reminder,
    }));
    return [...taskEntries, ...reminderEntries].sort((left, right) =>
      left.at.localeCompare(right.at),
    );
  }, [reminders, tasks, threadTitles]);

  const groupedEntries = useMemo(() => {
    const visible =
      view === "calendar"
        ? entries.filter((entry) => localDateKey(entry.at) === selectedDate)
        : entries;
    const groups = new Map<string, ScheduleEntry[]>();
    for (const entry of visible) {
      const key = localDateKey(entry.at);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [entries, selectedDate, view]);

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = localDateKey(date);
      return {
        date,
        key,
        currentMonth: date.getMonth() === month.getMonth(),
        entries: entries.filter((entry) => localDateKey(entry.at) === key),
      };
    });
  }, [entries, month]);

  const todayKey = localDateKey(new Date());
  const dueCount = reminders.filter((reminder) => reminder.status === "DUE").length;
  const todayCount = entries.filter((entry) => localDateKey(entry.at) === todayKey).length;
  const activeCount = entries.filter(
    (entry) => entry.tone === "active" || entry.tone === "due",
  ).length;

  async function createReminder(event: FormEvent) {
    event.preventDefault();
    if (busyId || !form.title.trim()) return;
    const scheduledAt = new Date(form.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now() + 2_000) {
      onNotice("error", "请选择至少晚于当前时间 2 秒的提醒时间");
      return;
    }
    setBusyId("new");
    try {
      const input: SaveAiAssistantReminderInput = {
        threadId: form.threadId,
        title: form.title.trim(),
        note: form.note.trim(),
        scheduledAt: scheduledAt.toISOString(),
      };
      const result = await api.createAiAssistantReminder(assistant.id, input);
      setReminders((current) => [...current, result.reminder]);
      setEditorOpen(false);
      setSelectedDate(localDateKey(result.reminder.scheduledAt));
      onNotice("success", "提醒已创建");
    } catch (error) {
      onNotice("error", errorMessage(error, "提醒创建失败"));
    } finally {
      setBusyId(null);
    }
  }

  async function updateReminder(
    reminder: AiAssistantReminder,
    input: { completed?: boolean; scheduledAt?: string },
    successText: string,
  ) {
    if (busyId) return;
    setBusyId(reminder.id);
    try {
      const result = await api.updateAiAssistantReminder(assistant.id, reminder.id, input);
      setReminders((current) =>
        current.map((item) => (item.id === result.reminder.id ? result.reminder : item)),
      );
      onNotice("success", successText);
    } catch (error) {
      onNotice("error", errorMessage(error, "提醒更新失败"));
    } finally {
      setBusyId(null);
    }
  }

  async function snoozeReminder(reminder: AiAssistantReminder, minutes: number) {
    const next = new Date(Date.now() + minutes * 60_000);
    next.setSeconds(0, 0);
    await updateReminder(
      reminder,
      { scheduledAt: next.toISOString() },
      `已推迟 ${minutes < 60 ? `${minutes} 分钟` : minutes === 60 ? "1 小时" : "到明天"}`,
    );
  }

  async function removeReminder(reminder: AiAssistantReminder) {
    if (busyId) return;
    setBusyId(reminder.id);
    try {
      await api.deleteAiAssistantReminder(assistant.id, reminder.id);
      setReminders((current) => current.filter((item) => item.id !== reminder.id));
      setConfirmDeleteId(null);
      onNotice("success", "提醒已删除");
    } catch (error) {
      onNotice("error", errorMessage(error, "提醒删除失败"));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleTask(task: AiAssistantTask) {
    if (busyId || (!task.enabled && !task.nextRunAt)) return;
    setBusyId(task.id);
    try {
      const result = await api.updateAiAssistantTask(assistant.id, task.id, {
        enabled: !task.enabled,
      });
      setTasks((current) =>
        current.map((item) => (item.id === result.task.id ? result.task : item)),
      );
      onNotice("success", task.enabled ? "自动任务已暂停" : "自动任务已恢复");
    } catch (error) {
      onNotice("error", errorMessage(error, "任务状态更新失败"));
    } finally {
      setBusyId(null);
    }
  }

  function renderEntry(entry: ScheduleEntry) {
    const reminder = entry.reminder;
    const task = entry.task;
    return (
      <article
        className={`assistant-schedule-entry is-${entry.kind.toLowerCase()} is-${entry.tone}`}
        key={entry.id}
      >
        <span className="assistant-schedule-entry-icon">
          {entry.kind === "TASK" ? <Bot size={16} /> : <Bell size={16} />}
        </span>
        <div className="assistant-schedule-entry-copy">
          <header>
            <strong>{entry.title}</strong>
            <span>{entry.kind === "TASK" ? "自动任务" : "提醒"}</span>
          </header>
          {reminder?.note && <p>{reminder.note}</p>}
          {task && <p>{task.prompt}</p>}
          <footer>
            <span>
              <Clock3 size={11} /> {formatScheduleTime(entry.at)}
            </span>
            <button type="button" onClick={() => onOpenThread(entry.threadId)}>
              <MessageSquareText size={11} /> {entry.threadTitle}
            </button>
            {task && <span>{taskScheduleLabel(task)}</span>}
            {entry.tone === "due" && <b>已到期</b>}
            {entry.tone === "paused" && <b>已暂停</b>}
            {entry.tone === "completed" && <b>已完成</b>}
          </footer>
        </div>
        <div className="assistant-schedule-entry-actions">
          {task && (
            <>
              <button type="button" onClick={() => onOpenTask(task.threadId)} title="打开任务">
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                onClick={() => void toggleTask(task)}
                disabled={Boolean(busyId) || (!task.enabled && !task.nextRunAt)}
                title={task.enabled ? "暂停" : "恢复"}
              >
                {task.enabled ? <Pause size={13} /> : <Play size={13} />}
              </button>
            </>
          )}
          {reminder && reminder.status !== "COMPLETED" && (
            <>
              <button
                type="button"
                onClick={() => void updateReminder(reminder, { completed: true }, "提醒已完成")}
                disabled={Boolean(busyId)}
                title="完成"
              >
                <Check size={14} />
              </button>
              <div className="assistant-reminder-snooze">
                <button type="button" title="推迟提醒">
                  <AlarmClock size={13} />
                </button>
                <span>
                  <button type="button" onClick={() => void snoozeReminder(reminder, 10)}>
                    10 分钟
                  </button>
                  <button type="button" onClick={() => void snoozeReminder(reminder, 60)}>
                    1 小时
                  </button>
                  <button type="button" onClick={() => void snoozeReminder(reminder, 1440)}>
                    明天
                  </button>
                </span>
              </div>
            </>
          )}
          {reminder?.status === "COMPLETED" && (
            <button
              type="button"
              onClick={() =>
                void updateReminder(
                  reminder,
                  { scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString() },
                  "提醒已重新安排",
                )
              }
              disabled={Boolean(busyId)}
              title="重新安排到 30 分钟后"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {reminder &&
            (confirmDeleteId === reminder.id ? (
              <span className="assistant-reminder-delete-confirm">
                <button type="button" onClick={() => setConfirmDeleteId(null)}>
                  取消
                </button>
                <button type="button" onClick={() => void removeReminder(reminder)}>
                  删除
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDeleteId(reminder.id)}
                title="删除提醒"
              >
                <Trash2 size={13} />
              </button>
            ))}
        </div>
      </article>
    );
  }

  return (
    <section className="assistant-schedule-panel" aria-label="日程与提醒中心">
      <header className="assistant-schedule-heading">
        <div>
          <span className="assistant-schedule-mark">
            <CalendarDays size={18} />
          </span>
          <span>
            <strong>日程与提醒</strong>
            <small>统一查看自动任务的下一次执行和个人提醒</small>
          </span>
        </div>
        <div>
          <span className="assistant-schedule-summary">
            {dueCount > 0 && <b>{dueCount} 条到期</b>}
            <i>{todayCount} 条今天</i>
            <i>{activeCount} 条待处理</i>
          </span>
          <div className="assistant-schedule-view-switch" role="tablist" aria-label="日程视图">
            <button
              type="button"
              role="tab"
              aria-selected={view === "agenda"}
              className={view === "agenda" ? "is-active" : ""}
              onClick={() => setView("agenda")}
            >
              <List size={13} /> 列表
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "calendar"}
              className={view === "calendar" ? "is-active" : ""}
              onClick={() => setView("calendar")}
            >
              <CalendarDays size={13} /> 日历
            </button>
          </div>
          <button
            className="assistant-schedule-create"
            type="button"
            onClick={() => {
              setForm(emptyReminderForm(selectedThreadId));
              setEditorOpen(true);
            }}
          >
            <Plus size={14} /> 新建提醒
          </button>
        </div>
      </header>

      {editorOpen && (
        <form
          className="assistant-reminder-editor"
          onSubmit={(event) => void createReminder(event)}
        >
          <header>
            <span>
              <Bell size={14} /> 新建提醒
            </span>
            <button type="button" onClick={() => setEditorOpen(false)} aria-label="关闭提醒编辑">
              <X size={14} />
            </button>
          </header>
          <label>
            <span>提醒名称</span>
            <input
              value={form.title}
              onChange={(event) =>
                setForm((current) => ({ ...current, title: event.target.value }))
              }
              maxLength={80}
              autoFocus
            />
          </label>
          <label>
            <span>时间</span>
            <input
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(event) =>
                setForm((current) => ({ ...current, scheduledAt: event.target.value }))
              }
            />
          </label>
          <label>
            <span>所属对话</span>
            <select
              value={form.threadId}
              onChange={(event) =>
                setForm((current) => ({ ...current, threadId: event.target.value }))
              }
            >
              {threads
                .filter((thread) => !thread.archived)
                .map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="is-wide">
            <span>
              备注 <small>可选</small>
            </span>
            <input
              value={form.note}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              maxLength={500}
              placeholder="到期时一并显示"
            />
          </label>
          <button type="submit" disabled={Boolean(busyId) || !form.title.trim()}>
            {busyId === "new" ? <LoaderCircle className="spin" size={14} /> : <Bell size={14} />}
            保存提醒
          </button>
        </form>
      )}

      {view === "calendar" && (
        <div className="assistant-schedule-calendar">
          <header>
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1))}
              aria-label="上个月"
            >
              <ChevronLeft size={15} />
            </button>
            <strong>
              {month.getFullYear()} 年 {month.getMonth() + 1} 月
            </strong>
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1))}
              aria-label="下个月"
            >
              <ChevronRight size={15} />
            </button>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setMonth(new Date(now.getFullYear(), now.getMonth()));
                setSelectedDate(localDateKey(now));
              }}
            >
              今天
            </button>
          </header>
          <div className="assistant-calendar-weekdays">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="assistant-calendar-grid">
            {calendarDays.map((day) => (
              <button
                type="button"
                key={day.key}
                className={`${day.currentMonth ? "" : "is-outside"} ${day.key === todayKey ? "is-today" : ""} ${day.key === selectedDate ? "is-selected" : ""}`}
                onClick={() => setSelectedDate(day.key)}
              >
                <span>{day.date.getDate()}</span>
                {day.entries.length > 0 && (
                  <i>
                    {day.entries.slice(0, 3).map((entry) => (
                      <b
                        className={`is-${entry.kind.toLowerCase()} is-${entry.tone}`}
                        key={entry.id}
                      />
                    ))}
                  </i>
                )}
                {day.entries.length > 3 && <small>+{day.entries.length - 3}</small>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="assistant-schedule-list">
        {loading ? (
          <div className="assistant-schedule-empty">
            <LoaderCircle className="spin" size={21} /> 正在整理日程
          </div>
        ) : groupedEntries.length === 0 ? (
          <div className="assistant-schedule-empty">
            <span>
              <CheckCircle2 size={22} />
            </span>
            <strong>{view === "calendar" ? "这一天没有安排" : "日程已经清空"}</strong>
            <small>新建提醒，或在“任务”中安排自动执行。</small>
          </div>
        ) : (
          groupedEntries.map(([key, dayEntries]) => (
            <section className="assistant-schedule-day" key={key}>
              <header>
                <strong>{formatDayTitle(key)}</strong>
                <span>{dayEntries.length} 项</span>
              </header>
              <div>{dayEntries.map(renderEntry)}</div>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
