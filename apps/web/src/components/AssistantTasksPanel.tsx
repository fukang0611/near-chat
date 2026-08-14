import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  LoaderCircle,
  MessageSquareText,
  Pause,
  PencilLine,
  Play,
  Plus,
  Save,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, type SaveAiAssistantTaskInput } from "../api";
import type { AiAssistant, AiAssistantTask, AiAssistantTaskSchedule } from "../types";
import { errorMessage } from "../utils/errors";

interface AssistantTasksPanelProps {
  assistant: AiAssistant;
  refreshVersion: number;
  onNotice: (tone: "error" | "success", text: string) => void;
  onOpenMessage: (messageId: string) => void;
}

interface TaskForm {
  title: string;
  prompt: string;
  scheduleType: AiAssistantTaskSchedule;
  scheduledFor: string;
  enabled: boolean;
}

const SCHEDULE_META: Record<AiAssistantTaskSchedule, { label: string; detail: string }> = {
  ONCE: { label: "一次", detail: "在指定时刻执行一次" },
  DAILY: { label: "每天", detail: "从首次时间起每 24 小时" },
  WEEKLY: { label: "每周", detail: "从首次时间起每 7 天" },
};

function localDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

function emptyTaskForm(): TaskForm {
  const scheduledFor = new Date(Date.now() + 10 * 60_000);
  scheduledFor.setSeconds(0, 0);
  return {
    title: "",
    prompt: "",
    scheduleType: "ONCE",
    scheduledFor: localDateTime(scheduledFor),
    enabled: true,
  };
}

function taskForm(task: AiAssistantTask): TaskForm {
  const nextRunAt = task.nextRunAt ? new Date(task.nextRunAt) : null;
  const editableRunAt =
    nextRunAt && nextRunAt.getTime() > Date.now() ? nextRunAt : new Date(Date.now() + 10 * 60_000);
  return {
    title: task.title,
    prompt: task.prompt,
    scheduleType: task.scheduleType,
    scheduledFor: localDateTime(editableRunAt),
    enabled: task.enabled,
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return "暂无下一次执行";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function runStatus(task: AiAssistantTask) {
  if (task.runRequested) return { label: "等待执行", tone: "queued" };
  if (task.lastStatus === "RUNNING") return { label: "执行中", tone: "running" };
  if (task.lastStatus === "SUCCEEDED") return { label: "最近成功", tone: "success" };
  if (task.lastStatus === "FAILED") return { label: "最近失败", tone: "failed" };
  return { label: "尚未执行", tone: "idle" };
}

/** 助理任务定义和最近执行历史均由此组件维护，主对话只接收定位动作。 */
export function AssistantTasksPanel({
  assistant,
  refreshVersion,
  onNotice,
  onOpenMessage,
}: AssistantTasksPanelProps) {
  const [tasks, setTasks] = useState<AiAssistantTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<TaskForm>(() => emptyTaskForm());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const loadedAssistantIdRef = useRef<string | null>(null);
  const loadSequenceRef = useRef(0);

  const loadTasks = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    try {
      const result = await api.aiAssistantTasks(assistant.id);
      if (sequence === loadSequenceRef.current) setTasks(result.tasks);
    } catch (error) {
      if (sequence === loadSequenceRef.current) {
        onNotice("error", errorMessage(error, "助理任务加载失败"));
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [assistant.id, onNotice]);

  useEffect(() => {
    if (loadedAssistantIdRef.current !== assistant.id) {
      setEditingId(null);
      setConfirmDeleteId(null);
      loadedAssistantIdRef.current = assistant.id;
    }
    void loadTasks();
  }, [assistant.id, loadTasks, refreshVersion]);

  const openCreate = () => {
    setForm(emptyTaskForm());
    setEditingId("new");
    setConfirmDeleteId(null);
  };

  const openEdit = (task: AiAssistantTask) => {
    setForm(taskForm(task));
    setEditingId(task.id);
    setConfirmDeleteId(null);
  };

  const saveTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingId || busyId) return;
    const scheduledFor = new Date(form.scheduledFor);
    if (!form.title.trim() || !form.prompt.trim()) return;
    if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now() + 2_000) {
      onNotice("error", "请选择至少晚于当前时间 2 秒的执行时间");
      return;
    }
    const input: SaveAiAssistantTaskInput = {
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      scheduleType: form.scheduleType,
      scheduledFor: scheduledFor.toISOString(),
      enabled: form.enabled,
    };
    setBusyId(editingId);
    try {
      const result =
        editingId === "new"
          ? await api.createAiAssistantTask(assistant.id, input)
          : await api.updateAiAssistantTask(assistant.id, editingId, input);
      setTasks((current) => {
        const exists = current.some((task) => task.id === result.task.id);
        return exists
          ? current.map((task) => (task.id === result.task.id ? result.task : task))
          : [result.task, ...current];
      });
      setEditingId(null);
      onNotice("success", editingId === "new" ? "助理任务已创建" : "任务计划已保存");
    } catch (error) {
      onNotice("error", errorMessage(error, "助理任务保存失败"));
    } finally {
      setBusyId(null);
    }
  };

  const toggleTask = async (task: AiAssistantTask) => {
    if (busyId) return;
    setBusyId(task.id);
    try {
      const result = await api.updateAiAssistantTask(assistant.id, task.id, {
        enabled: !task.enabled,
      });
      setTasks((current) =>
        current.map((candidate) => (candidate.id === task.id ? result.task : candidate)),
      );
      onNotice("success", result.task.enabled ? "任务已恢复" : "任务已暂停");
    } catch (error) {
      onNotice("error", errorMessage(error, "任务状态更新失败"));
    } finally {
      setBusyId(null);
    }
  };

  const runTask = async (task: AiAssistantTask) => {
    if (busyId || task.runRequested || task.lastStatus === "RUNNING") return;
    setBusyId(task.id);
    try {
      const result = await api.runAiAssistantTask(assistant.id, task.id);
      setTasks((current) =>
        current.map((candidate) => (candidate.id === task.id ? result.task : candidate)),
      );
      onNotice("success", "任务已加入执行队列，完成后会通知你");
    } catch (error) {
      onNotice("error", errorMessage(error, "立即执行失败"));
    } finally {
      setBusyId(null);
    }
  };

  const deleteTask = async (task: AiAssistantTask) => {
    if (busyId) return;
    setBusyId(task.id);
    try {
      await api.deleteAiAssistantTask(assistant.id, task.id);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setConfirmDeleteId(null);
      onNotice("success", "助理任务已删除");
    } catch (error) {
      onNotice("error", errorMessage(error, "助理任务删除失败"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="assistant-task-workspace">
      <header className="assistant-task-heading">
        <div>
          <span>
            <CalendarClock size={18} />
          </span>
          <div>
            <strong>自动任务</strong>
            <small>到点后由 {assistant.name} 自动处理，结果进入助理对话</small>
          </div>
        </div>
        <button type="button" onClick={openCreate} disabled={Boolean(busyId)}>
          <Plus size={15} />
          新建任务
        </button>
      </header>

      {editingId && (
        <form className="assistant-task-editor" onSubmit={(event) => void saveTask(event)}>
          <header>
            <span>
              <strong>{editingId === "new" ? "创建自动任务" : "编辑任务计划"}</strong>
              <small>后台执行不携带旧对话，只使用角色说明和已绑定知识库</small>
            </span>
            <button type="button" onClick={() => setEditingId(null)} aria-label="关闭任务编辑">
              <X size={15} />
            </button>
          </header>
          <div className="assistant-task-form-grid">
            <label>
              <span>任务名称</span>
              <input
                type="text"
                value={form.title}
                onChange={(event) =>
                  setForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="例如：生成每日项目摘要"
                maxLength={80}
                autoFocus
              />
            </label>
            <label>
              <span>首次执行</span>
              <input
                type="datetime-local"
                step={1}
                value={form.scheduledFor}
                onChange={(event) =>
                  setForm((current) => ({ ...current, scheduledFor: event.target.value }))
                }
              />
            </label>
          </div>
          <label>
            <span>交给助理的任务内容</span>
            <textarea
              value={form.prompt}
              onChange={(event) =>
                setForm((current) => ({ ...current, prompt: event.target.value }))
              }
              placeholder="说明需要处理的信息、目标和期望输出格式"
              rows={3}
              maxLength={6000}
            />
          </label>
          <fieldset>
            <legend>执行频率</legend>
            <div className="assistant-task-schedules">
              {(Object.keys(SCHEDULE_META) as AiAssistantTaskSchedule[]).map((schedule) => (
                <button
                  type="button"
                  className={form.scheduleType === schedule ? "is-active" : ""}
                  aria-pressed={form.scheduleType === schedule}
                  key={schedule}
                  onClick={() => setForm((current) => ({ ...current, scheduleType: schedule }))}
                >
                  <strong>{SCHEDULE_META[schedule].label}</strong>
                  <small>{SCHEDULE_META[schedule].detail}</small>
                </button>
              ))}
            </div>
          </fieldset>
          <footer>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              {editingId === "new" ? "创建后立即启用" : "保存后启用任务"}
            </label>
            <div>
              <button type="button" onClick={() => setEditingId(null)}>
                取消
              </button>
              <button
                type="submit"
                disabled={Boolean(busyId) || !form.title.trim() || !form.prompt.trim()}
              >
                {busyId ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
                保存任务
              </button>
            </div>
          </footer>
        </form>
      )}

      <div className="assistant-task-scroll">
        {loading ? (
          <div className="assistant-task-empty">
            <LoaderCircle className="spin" size={22} />
            <strong>正在读取任务</strong>
          </div>
        ) : tasks.length === 0 ? (
          <button type="button" className="assistant-task-empty is-action" onClick={openCreate}>
            <span>
              <CalendarClock size={25} />
            </span>
            <strong>让助理在合适的时间主动工作</strong>
            <small>可以做周期摘要、资料整理、计划提醒，结果会自动留在对话里。</small>
            <em>
              <Plus size={13} /> 创建第一个任务
            </em>
          </button>
        ) : (
          <div className="assistant-task-list">
            {tasks.map((task) => {
              const status = runStatus(task);
              const completedOnce = task.scheduleType === "ONCE" && !task.nextRunAt;
              return (
                <article
                  className={`assistant-task-card ${!task.enabled ? "is-paused" : ""}`}
                  key={task.id}
                >
                  <header>
                    <span className="assistant-task-icon">
                      {task.lastStatus === "FAILED" ? <AlertCircle size={18} /> : <Zap size={18} />}
                    </span>
                    <div>
                      <strong>{task.title}</strong>
                      <small>{task.prompt}</small>
                    </div>
                    <span className={`assistant-task-status is-${status.tone}`}>
                      <i />
                      {status.label}
                    </span>
                  </header>
                  <div className="assistant-task-plan">
                    <span>
                      <CalendarClock size={13} />
                      <strong>{SCHEDULE_META[task.scheduleType].label}</strong>
                    </span>
                    <span>
                      <Clock3 size={13} />
                      {completedOnce ? "一次任务已完成" : formatDateTime(task.nextRunAt)}
                    </span>
                    <span>
                      <History size={13} />
                      已执行 {task.runCount} 次
                    </span>
                  </div>
                  {task.lastError && (
                    <div className="assistant-task-error">
                      <AlertCircle size={13} />
                      {task.lastError}
                    </div>
                  )}
                  {task.recentRuns.length > 0 && (
                    <div className="assistant-task-history">
                      {task.recentRuns.slice(0, 3).map((run) => (
                        <div key={run.id}>
                          {run.status === "SUCCEEDED" ? (
                            <CheckCircle2 size={13} />
                          ) : run.status === "FAILED" ? (
                            <AlertCircle size={13} />
                          ) : (
                            <LoaderCircle className="spin" size={13} />
                          )}
                          <span>
                            <strong>
                              {run.trigger === "MANUAL" ? "手动执行" : "计划执行"} ·{" "}
                              {run.status === "SUCCEEDED"
                                ? "已完成"
                                : run.status === "FAILED"
                                  ? "失败"
                                  : "执行中"}
                            </strong>
                            <small>{formatDateTime(run.startedAt)}</small>
                          </span>
                          {run.resultMessageId && (
                            <button
                              type="button"
                              onClick={() => onOpenMessage(run.resultMessageId!)}
                            >
                              <MessageSquareText size={12} />
                              查看结果
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <footer>
                    <button
                      type="button"
                      onClick={() => void runTask(task)}
                      disabled={
                        Boolean(busyId) || task.runRequested || task.lastStatus === "RUNNING"
                      }
                    >
                      <Play size={13} />
                      {task.runRequested ? "已排队" : "立即执行"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleTask(task)}
                      disabled={Boolean(busyId) || completedOnce}
                      title={completedOnce ? "编辑执行时间后可重新启用" : undefined}
                    >
                      {task.enabled ? <Pause size={13} /> : <Play size={13} />}
                      {completedOnce ? "已完成" : task.enabled ? "暂停" : "恢复"}
                    </button>
                    <button type="button" onClick={() => openEdit(task)} disabled={Boolean(busyId)}>
                      <PencilLine size={13} />
                      编辑
                    </button>
                    {confirmDeleteId === task.id ? (
                      <span className="assistant-task-delete-confirm">
                        <small>删除任务和历史？</small>
                        <button type="button" onClick={() => setConfirmDeleteId(null)}>
                          取消
                        </button>
                        <button type="button" onClick={() => void deleteTask(task)}>
                          删除
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => setConfirmDeleteId(task.id)}
                        disabled={Boolean(busyId)}
                        aria-label={`删除任务 ${task.title}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
