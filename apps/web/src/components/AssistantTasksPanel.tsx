import {
  AlertCircle,
  Camera,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  Globe2,
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
import type {
  AiAssistant,
  AiAssistantBrowserPermission,
  AiAssistantFile,
  AiAssistantTask,
  AiAssistantTaskBrowserAction,
  AiAssistantTaskSchedule,
} from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";

interface AssistantTasksPanelProps {
  assistant: AiAssistant;
  files: AiAssistantFile[];
  refreshVersion: number;
  onNotice: (tone: "error" | "success", text: string) => void;
  onOpenMessage: (messageId: string) => void;
  onOpenBrowserRun: (runId: string) => void;
  onOpenBrowserSettings: () => void;
  onOpenFiles: () => void;
}

interface TaskForm {
  title: string;
  prompt: string;
  scheduleType: AiAssistantTaskSchedule;
  scheduledFor: string;
  enabled: boolean;
  fileIds: string[];
  browserAction: AiAssistantTaskBrowserAction;
  browserUrl: string;
}

const SCHEDULE_META: Record<AiAssistantTaskSchedule, { label: string; detail: string }> = {
  ONCE: { label: "一次", detail: "在指定时刻执行一次" },
  DAILY: { label: "每天", detail: "从首次时间起每 24 小时" },
  WEEKLY: { label: "每周", detail: "从首次时间起每 7 天" },
};

const BROWSER_META: Record<
  AiAssistantTaskBrowserAction,
  { label: string; detail: string; icon: typeof Globe2 }
> = {
  NONE: { label: "不使用", detail: "只处理任务文字和所选文件", icon: Globe2 },
  READ: { label: "读取页面", detail: "提取标题与可见文字", icon: Globe2 },
  SCREENSHOT: { label: "保存截图", detail: "生成整页截图并交给助理", icon: Camera },
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
    fileIds: [],
    browserAction: "NONE",
    browserUrl: "",
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
    fileIds: task.fileIds,
    browserAction: task.browserAction,
    browserUrl: task.browserUrl ?? "",
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
  files,
  refreshVersion,
  onNotice,
  onOpenMessage,
  onOpenBrowserRun,
  onOpenBrowserSettings,
  onOpenFiles,
}: AssistantTasksPanelProps) {
  const [tasks, setTasks] = useState<AiAssistantTask[]>([]);
  const [browserPermission, setBrowserPermission] = useState<AiAssistantBrowserPermission | null>(
    null,
  );
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
      const [taskResult, permissionResult] = await Promise.all([
        api.aiAssistantTasks(assistant.id),
        api.aiAssistantBrowserPermission(assistant.id),
      ]);
      if (sequence === loadSequenceRef.current) {
        setTasks(taskResult.tasks);
        setBrowserPermission(permissionResult.permission);
      }
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
      fileIds: form.fileIds,
      browserAction: form.browserAction,
      browserUrl: form.browserAction === "NONE" ? null : form.browserUrl.trim(),
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

  const toggleFile = (fileId: string) => {
    setForm((current) => {
      if (current.fileIds.includes(fileId)) {
        return { ...current, fileIds: current.fileIds.filter((id) => id !== fileId) };
      }
      if (current.fileIds.length >= 5) {
        onNotice("error", "每个自动任务最多授权 5 个文件");
        return current;
      }
      return { ...current, fileIds: [...current.fileIds, fileId] };
    });
  };

  const selectBrowserAction = (action: AiAssistantTaskBrowserAction) => {
    if (action === "READ" && !browserPermission?.enabled) return;
    if (
      action === "SCREENSHOT" &&
      (!browserPermission?.enabled || !browserPermission.allowScreenshot)
    ) {
      return;
    }
    setForm((current) => ({ ...current, browserAction: action }));
  };

  const processableFiles = files.filter((file) => file.processable);

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
          <fieldset className="assistant-task-tools">
            <legend>本次任务可使用的工具</legend>
            <section>
              <header>
                <span>
                  <FileText size={14} />
                  <strong>助理文件</strong>
                  <small>仅会读取你在这里明确勾选的文件，最多 5 个</small>
                </span>
                <button type="button" onClick={onOpenFiles}>
                  管理文件
                </button>
              </header>
              {processableFiles.length > 0 ? (
                <div className="assistant-task-file-options">
                  {processableFiles.map((file) => (
                    <button
                      type="button"
                      className={form.fileIds.includes(file.id) ? "is-selected" : ""}
                      aria-pressed={form.fileIds.includes(file.id)}
                      key={file.id}
                      onClick={() => toggleFile(file.id)}
                    >
                      <span>
                        {form.fileIds.includes(file.id) ? <CheckCircle2 size={13} /> : null}
                      </span>
                      <strong title={file.attachment.originalName}>
                        {file.attachment.originalName}
                      </strong>
                      <small>{formatBytes(file.attachment.sizeBytes)}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p>暂无可读取的文档。可先在文件工作区添加 TXT、Markdown、PDF 或表格。</p>
              )}
            </section>
            <section>
              <header>
                <span>
                  <Globe2 size={14} />
                  <strong>受控浏览器</strong>
                  <small>自动任务只允许读取或截图，不会点击和填写</small>
                </span>
                <button type="button" onClick={onOpenBrowserSettings}>
                  授权设置
                </button>
              </header>
              <div className="assistant-task-browser-options">
                {(Object.keys(BROWSER_META) as AiAssistantTaskBrowserAction[]).map((action) => {
                  const meta = BROWSER_META[action];
                  const Icon = meta.icon;
                  const disabled =
                    (action === "READ" && !browserPermission?.enabled) ||
                    (action === "SCREENSHOT" &&
                      (!browserPermission?.enabled || !browserPermission.allowScreenshot));
                  return (
                    <button
                      type="button"
                      className={form.browserAction === action ? "is-active" : ""}
                      aria-pressed={form.browserAction === action}
                      disabled={disabled}
                      title={disabled ? "请先在浏览器工作区完成相应授权" : undefined}
                      key={action}
                      onClick={() => selectBrowserAction(action)}
                    >
                      <Icon size={14} />
                      <span>
                        <strong>{meta.label}</strong>
                        <small>{meta.detail}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              {form.browserAction !== "NONE" && (
                <label className="assistant-task-browser-url">
                  <span>目标页面</span>
                  <input
                    type="url"
                    value={form.browserUrl}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, browserUrl: event.target.value }))
                    }
                    placeholder="https://intranet.example.com/status"
                    required
                  />
                  <small>为避免凭据进入任务记录，定时网址不能包含查询参数或 # 片段。</small>
                </label>
              )}
            </section>
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
                  {(task.fileIds.length > 0 || task.browserAction !== "NONE") && (
                    <div className="assistant-task-authorizations">
                      {task.fileIds.length > 0 && (
                        <span>
                          <FileText size={12} /> {task.fileIds.length} 个文件
                        </span>
                      )}
                      {task.browserAction !== "NONE" && (
                        <span>
                          {task.browserAction === "SCREENSHOT" ? (
                            <Camera size={12} />
                          ) : (
                            <Globe2 size={12} />
                          )}
                          {BROWSER_META[task.browserAction].label}
                        </span>
                      )}
                    </div>
                  )}
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
                          <span className="assistant-task-run-actions">
                            {run.browserRunId && (
                              <button
                                type="button"
                                onClick={() => onOpenBrowserRun(run.browserRunId!)}
                              >
                                <Globe2 size={12} />
                                执行记录
                              </button>
                            )}
                            {run.resultMessageId && (
                              <button
                                type="button"
                                onClick={() => onOpenMessage(run.resultMessageId!)}
                              >
                                <MessageSquareText size={12} />
                                查看结果
                              </button>
                            )}
                          </span>
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
