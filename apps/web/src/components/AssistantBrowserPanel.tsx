import {
  Camera,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  ExternalLink,
  FileImage,
  Globe2,
  LoaderCircle,
  MousePointerClick,
  Plus,
  RefreshCw,
  ShieldCheck,
  TextCursorInput,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  AiAssistant,
  AiAssistantBrowserAction,
  AiAssistantBrowserElement,
  AiAssistantBrowserPermission,
  AiAssistantBrowserRun,
  AiAssistantBrowserRunStatus,
  AiAssistantBrowserStep,
} from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes, formatClock } from "../utils/format";

interface AssistantBrowserPanelProps {
  assistant: AiAssistant;
  onNotice: (tone: "success" | "error", text: string) => void;
  onFilesChanged: () => void;
  /** 从自动任务执行历史进入时，直接定位到对应的受控浏览器记录。 */
  focusRunId?: string | null;
}

const RUN_STATUS: Record<
  AiAssistantBrowserRunStatus,
  { label: string; tone: "waiting" | "active" | "success" | "danger" | "neutral" }
> = {
  AWAITING_CONFIRMATION: { label: "等待确认", tone: "waiting" },
  ACTIVE: { label: "执行中", tone: "active" },
  SUCCEEDED: { label: "已完成", tone: "success" },
  FAILED: { label: "失败", tone: "danger" },
  CANCELLED: { label: "已取消", tone: "neutral" },
  EXPIRED: { label: "已过期", tone: "neutral" },
};

const ACTION_LABEL: Record<AiAssistantBrowserAction, string> = {
  OPEN: "打开页面",
  READ: "读取页面",
  SCREENSHOT: "保存截图",
  CLICK: "点击元素",
  FILL: "填写文字",
};

function actionIcon(action: AiAssistantBrowserAction) {
  if (action === "SCREENSHOT") return <Camera size={14} />;
  if (action === "CLICK") return <MousePointerClick size={14} />;
  if (action === "FILL") return <TextCursorInput size={14} />;
  if (action === "READ") return <RefreshCw size={14} />;
  return <Globe2 size={14} />;
}

function isTerminal(status: AiAssistantBrowserRunStatus): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(status);
}

function elementName(element: AiAssistantBrowserElement): string {
  const kind =
    element.kind === "LINK"
      ? "链接"
      : element.kind === "BUTTON"
        ? "按钮"
        : element.kind === "SELECT"
          ? "选项"
          : "输入";
  return `${element.ref} · ${kind} · ${element.label || "未命名元素"}`;
}

function pendingDescription(run: AiAssistantBrowserRun, step: AiAssistantBrowserStep): string {
  if (step.action === "OPEN") return `将访问 ${run.startUrl}，并读取页面标题、可见文字和元素。`;
  if (step.action === "READ") return "将重新读取当前页面，不会点击或填写任何内容。";
  if (step.action === "SCREENSHOT") {
    return "将生成整页 PNG 截图并保存到当前助理的文件工作区，占用个人文件配额。";
  }
  const label = String(step.input.elementLabel ?? step.input.elementRef ?? "所选元素");
  if (step.action === "CLICK")
    return `将点击“${label}”；若它是提交按钮，页面可能立即产生外部操作。`;
  return `将把你在确认框中输入的文字填写到“${label}”，文字内容不会写入执行记录。`;
}

/**
 * 受控浏览器工作区。所有网络访问与页面交互都先创建持久化步骤，再由用户确认；
 * 前端只选择服务端快照中的 e1/e2 元素引用，不接受 CSS 选择器或脚本。
 */
export function AssistantBrowserPanel({
  assistant,
  onNotice,
  onFilesChanged,
  focusRunId = null,
}: AssistantBrowserPanelProps) {
  const [permission, setPermission] = useState<AiAssistantBrowserPermission | null>(null);
  const [permissionDraft, setPermissionDraft] = useState({
    enabled: false,
    allowScreenshot: false,
    allowInteraction: false,
  });
  const [runs, setRuns] = useState<AiAssistantBrowserRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPermission, setSavingPermission] = useState(false);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [action, setAction] = useState<Exclude<AiAssistantBrowserAction, "OPEN">>("READ");
  const [elementRef, setElementRef] = useState("");
  const [fillValue, setFillValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [permissionResult, runResult] = await Promise.all([
        api.aiAssistantBrowserPermission(assistant.id),
        api.aiAssistantBrowserRuns(assistant.id),
      ]);
      setPermission(permissionResult.permission);
      setPermissionDraft({
        enabled: permissionResult.permission.enabled,
        allowScreenshot: permissionResult.permission.allowScreenshot,
        allowInteraction: permissionResult.permission.allowInteraction,
      });
      setRuns(runResult.runs);
      setSelectedRunId((current) =>
        focusRunId && runResult.runs.some((run) => run.id === focusRunId)
          ? focusRunId
          : runResult.runs.some((run) => run.id === current)
            ? current
            : (runResult.runs[0]?.id ?? null),
      );
    } catch (error) {
      onNotice("error", errorMessage(error, "浏览器工具加载失败"));
    } finally {
      setLoading(false);
    }
  }, [assistant.id, focusRunId, onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusRunId && runs.some((run) => run.id === focusRunId)) {
      setSelectedRunId(focusRunId);
    }
  }, [focusRunId, runs]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const automaticRun = Boolean(selectedRun?.steps.some((step) => step.input.automatic === true));
  const pendingStep = selectedRun?.steps.find((step) => step.status === "AWAITING_CONFIRMATION");
  const elementOptions = useMemo(() => {
    if (!selectedRun) return [];
    if (action === "CLICK") {
      return selectedRun.pageElements.filter(
        (element) => !element.disabled && ["LINK", "BUTTON"].includes(element.kind),
      );
    }
    if (action === "FILL") {
      return selectedRun.pageElements.filter(
        (element) => !element.disabled && ["INPUT", "TEXTAREA", "EDITABLE"].includes(element.kind),
      );
    }
    return [];
  }, [action, selectedRun]);

  useEffect(() => {
    if (action === "CLICK" || action === "FILL") {
      setElementRef((current) =>
        elementOptions.some((element) => element.ref === current)
          ? current
          : (elementOptions[0]?.ref ?? ""),
      );
    } else {
      setElementRef("");
    }
  }, [action, elementOptions]);

  const replaceRun = useCallback((run: AiAssistantBrowserRun) => {
    setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
    setSelectedRunId(run.id);
  }, []);

  async function savePermission() {
    setSavingPermission(true);
    try {
      const result = await api.updateAiAssistantBrowserPermission(assistant.id, {
        enabled: permissionDraft.enabled,
        allowScreenshot: permissionDraft.enabled && permissionDraft.allowScreenshot,
        allowInteraction: permissionDraft.enabled && permissionDraft.allowInteraction,
      });
      setPermission(result.permission);
      if (!result.permission.enabled) {
        const refreshed = await api.aiAssistantBrowserRuns(assistant.id);
        setRuns(refreshed.runs);
      }
      onNotice(
        "success",
        result.permission.enabled ? "浏览器工具授权已更新" : "浏览器工具已关闭，活动会话已终止",
      );
    } catch (error) {
      onNotice("error", errorMessage(error, "浏览器授权保存失败"));
    } finally {
      setSavingPermission(false);
    }
  }

  async function createRun(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const result = await api.createAiAssistantBrowserRun(assistant.id, goal, startUrl);
      replaceRun(result.run);
      setGoal("");
      setStartUrl("");
      onNotice("success", "执行已创建，请核对地址后确认打开");
    } catch (error) {
      onNotice("error", errorMessage(error, "浏览器执行创建失败"));
    } finally {
      setCreating(false);
    }
  }

  async function prepareStep() {
    if (!selectedRun) return;
    setWorking(true);
    try {
      const result = await api.prepareAiAssistantBrowserStep(assistant.id, selectedRun.id, {
        action,
        elementRef: action === "CLICK" || action === "FILL" ? elementRef : undefined,
      });
      replaceRun(result.run);
      setFillValue("");
    } catch (error) {
      onNotice("error", errorMessage(error, "确认步骤创建失败"));
    } finally {
      setWorking(false);
    }
  }

  async function confirmStep() {
    if (!selectedRun || !pendingStep) return;
    setWorking(true);
    try {
      const result = await api.confirmAiAssistantBrowserStep(
        assistant.id,
        selectedRun.id,
        pendingStep.id,
        pendingStep.action === "FILL" ? fillValue : undefined,
      );
      replaceRun(result.run);
      setFillValue("");
      if (pendingStep.action === "SCREENSHOT") onFilesChanged();
      onNotice("success", `${ACTION_LABEL[pendingStep.action]}已完成`);
    } catch (error) {
      onNotice("error", errorMessage(error, "浏览器步骤执行失败"));
      const refreshed = await api.aiAssistantBrowserRuns(assistant.id).catch(() => null);
      if (refreshed) {
        setRuns(refreshed.runs);
        setSelectedRunId(selectedRun.id);
      }
    } finally {
      setWorking(false);
    }
  }

  async function finishRun(outcome: "SUCCEEDED" | "CANCELLED") {
    if (!selectedRun) return;
    setWorking(true);
    try {
      const result = await api.finishAiAssistantBrowserRun(assistant.id, selectedRun.id, outcome);
      replaceRun(result.run);
      onNotice("success", outcome === "SUCCEEDED" ? "本次执行已完成" : "本次执行已取消");
    } catch (error) {
      onNotice("error", errorMessage(error, "浏览器执行结束失败"));
    } finally {
      setWorking(false);
    }
  }

  async function deleteRun(runId: string) {
    setWorking(true);
    try {
      await api.deleteAiAssistantBrowserRun(assistant.id, runId);
      const remaining = runs.filter((run) => run.id !== runId);
      setRuns(remaining);
      setSelectedRunId(remaining[0]?.id ?? null);
      setConfirmDeleteId(null);
      onNotice("success", "执行记录已删除");
    } catch (error) {
      onNotice("error", errorMessage(error, "执行记录删除失败"));
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return (
      <div className="assistant-browser-loading">
        <LoaderCircle className="spin" size={22} />
        正在读取浏览器工具状态
      </div>
    );
  }

  return (
    <div className="assistant-browser-workspace">
      <section className="assistant-browser-permission">
        <div className="assistant-browser-permission-copy">
          <span className="assistant-browser-shield">
            <ShieldCheck size={19} />
          </span>
          <div>
            <strong>受控浏览器</strong>
            <small>每一步都要确认；无痕会话结束后立即销毁 Cookie 与页面状态</small>
          </div>
        </div>
        <div className="assistant-browser-permission-options">
          <label>
            <input
              type="checkbox"
              checked={permissionDraft.enabled}
              onChange={(event) =>
                setPermissionDraft((current) => ({ ...current, enabled: event.target.checked }))
              }
            />
            <span>
              <strong>页面读取</strong>
              <small>打开网址并提取标题、可见文字与元素</small>
            </span>
          </label>
          <label className={!permissionDraft.enabled ? "is-disabled" : ""}>
            <input
              type="checkbox"
              checked={permissionDraft.allowScreenshot}
              disabled={!permissionDraft.enabled}
              onChange={(event) =>
                setPermissionDraft((current) => ({
                  ...current,
                  allowScreenshot: event.target.checked,
                }))
              }
            />
            <span>
              <strong>页面截图</strong>
              <small>截图会进入助理文件并占用个人配额</small>
            </span>
          </label>
          <label className={!permissionDraft.enabled ? "is-disabled" : ""}>
            <input
              type="checkbox"
              checked={permissionDraft.allowInteraction}
              disabled={!permissionDraft.enabled}
              onChange={(event) =>
                setPermissionDraft((current) => ({
                  ...current,
                  allowInteraction: event.target.checked,
                }))
              }
            />
            <span>
              <strong>表单交互</strong>
              <small>允许点击和填写；密码、文件上传与任意脚本始终禁止</small>
            </span>
          </label>
        </div>
        <button
          type="button"
          className="assistant-browser-permission-save"
          disabled={savingPermission}
          onClick={() => void savePermission()}
          title="保存浏览器工具授权"
        >
          {savingPermission ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          保存授权
        </button>
      </section>

      {!permission?.enabled ? (
        <div className="assistant-browser-disabled">
          <Globe2 size={28} />
          <h3>浏览器工具尚未启用</h3>
          <p>开启页面读取并保存授权后，才能为 {assistant.name} 创建受控执行。</p>
        </div>
      ) : (
        <div className="assistant-browser-main">
          <aside className="assistant-browser-history">
            <form onSubmit={(event) => void createRun(event)}>
              <div>
                <Plus size={15} />
                <strong>新建执行</strong>
              </div>
              <label>
                <span>浏览目标</span>
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="例如：读取项目公告并保存页面截图"
                  maxLength={500}
                  required
                />
              </label>
              <label>
                <span>起始地址</span>
                <input
                  value={startUrl}
                  onChange={(event) => setStartUrl(event.target.value)}
                  placeholder="https://intranet.example.com"
                  maxLength={2048}
                  required
                />
              </label>
              <button type="submit" disabled={creating || !goal.trim() || !startUrl.trim()}>
                {creating ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
                创建确认步骤
              </button>
            </form>

            <div className="assistant-browser-history-heading">
              <span>执行记录</span>
              <small>{runs.length}/20</small>
            </div>
            <div className="assistant-browser-run-list">
              {runs.length === 0 ? (
                <div className="assistant-browser-run-empty">还没有浏览器执行记录</div>
              ) : (
                runs.map((run) => {
                  const status = RUN_STATUS[run.status];
                  return (
                    <button
                      type="button"
                      key={run.id}
                      className={run.id === selectedRunId ? "is-active" : ""}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <span>
                        <strong>{run.goal}</strong>
                        <small>{run.pageTitle || new URL(run.startUrl).hostname}</small>
                      </span>
                      <span className={`assistant-browser-status is-${status.tone}`}>
                        {status.label}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="assistant-browser-detail">
            {!selectedRun ? (
              <div className="assistant-browser-detail-empty">
                <Globe2 size={30} />
                <h3>创建一次受控执行</h3>
                <p>页面不会在创建时自动打开，只有确认首个步骤后才会建立网络连接。</p>
              </div>
            ) : (
              <>
                <header className="assistant-browser-run-header">
                  <div>
                    <span className="assistant-browser-run-icon">
                      <Globe2 size={18} />
                    </span>
                    <span>
                      <strong>{selectedRun.goal}</strong>
                      <small title={selectedRun.currentUrl ?? selectedRun.startUrl}>
                        {selectedRun.pageTitle || selectedRun.currentUrl || selectedRun.startUrl}
                      </small>
                    </span>
                  </div>
                  <div>
                    <span
                      className={`assistant-browser-status is-${RUN_STATUS[selectedRun.status].tone}`}
                    >
                      {RUN_STATUS[selectedRun.status].label}
                    </span>
                    {!isTerminal(selectedRun.status) && !automaticRun && (
                      <>
                        <button
                          type="button"
                          onClick={() => void finishRun("SUCCEEDED")}
                          disabled={working || !selectedRun.openedAt}
                          title="结束并标记完成"
                        >
                          <CircleStop size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void finishRun("CANCELLED")}
                          disabled={working}
                          title="取消执行"
                        >
                          <X size={15} />
                        </button>
                      </>
                    )}
                    {isTerminal(selectedRun.status) &&
                      (confirmDeleteId === selectedRun.id ? (
                        <span className="assistant-browser-delete-confirm">
                          <button type="button" onClick={() => setConfirmDeleteId(null)}>
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteRun(selectedRun.id)}
                            disabled={working}
                          >
                            删除
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selectedRun.id)}
                          title="删除执行记录"
                        >
                          <Trash2 size={15} />
                        </button>
                      ))}
                  </div>
                </header>

                {automaticRun && !isTerminal(selectedRun.status) && (
                  <div className="assistant-browser-confirm-card is-automatic">
                    <span className="assistant-browser-confirm-icon">
                      <LoaderCircle className="spin" size={15} />
                    </span>
                    <div>
                      <small>自动任务 · 已在任务定义中预授权</small>
                      <strong>只读工具正在执行</strong>
                      <p>本次只会打开目标页面并读取或截图，不会点击元素和填写内容。</p>
                    </div>
                  </div>
                )}

                {pendingStep && !automaticRun && (
                  <div className="assistant-browser-confirm-card">
                    <span className="assistant-browser-confirm-icon">
                      {actionIcon(pendingStep.action)}
                    </span>
                    <div>
                      <small>第 {pendingStep.sequence} 步 · 等待你的确认</small>
                      <strong>{ACTION_LABEL[pendingStep.action]}</strong>
                      <p>{pendingDescription(selectedRun, pendingStep)}</p>
                      {pendingStep.action === "FILL" && (
                        <label>
                          <span>本次填写内容</span>
                          <input
                            type="text"
                            value={fillValue}
                            onChange={(event) => setFillValue(event.target.value)}
                            placeholder="操作参数不落库；页面返回内容仍会保存摘要"
                            maxLength={2000}
                            autoComplete="off"
                          />
                        </label>
                      )}
                      <button type="button" onClick={() => void confirmStep()} disabled={working}>
                        {working ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <ShieldCheck size={14} />
                        )}
                        确认执行此步骤
                      </button>
                    </div>
                  </div>
                )}

                {selectedRun.status === "ACTIVE" && !pendingStep && !automaticRun && (
                  <div className="assistant-browser-actions">
                    <label>
                      <span>下一步</span>
                      <select
                        value={action}
                        onChange={(event) =>
                          setAction(event.target.value as Exclude<AiAssistantBrowserAction, "OPEN">)
                        }
                      >
                        <option value="READ">重新读取页面</option>
                        {permission.allowScreenshot && (
                          <option value="SCREENSHOT">保存整页截图</option>
                        )}
                        {permission.allowInteraction && <option value="CLICK">点击页面元素</option>}
                        {permission.allowInteraction && <option value="FILL">填写文本区域</option>}
                      </select>
                    </label>
                    {(action === "CLICK" || action === "FILL") && (
                      <label className="is-element">
                        <span>页面元素</span>
                        <select
                          value={elementRef}
                          onChange={(event) => setElementRef(event.target.value)}
                        >
                          {elementOptions.length === 0 ? (
                            <option value="">当前页面没有可用元素</option>
                          ) : (
                            elementOptions.map((element) => (
                              <option value={element.ref} key={element.ref}>
                                {elementName(element)}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => void prepareStep()}
                      disabled={
                        working || ((action === "CLICK" || action === "FILL") && !elementRef)
                      }
                    >
                      {actionIcon(action)}
                      生成确认步骤
                    </button>
                  </div>
                )}

                {selectedRun.errorMessage && (
                  <div className="assistant-browser-error">{selectedRun.errorMessage}</div>
                )}

                <div className="assistant-browser-page">
                  <div className="assistant-browser-page-heading">
                    <span>
                      <ExternalLink size={14} />
                      <strong>{selectedRun.pageTitle || "页面尚未打开"}</strong>
                    </span>
                    <small>{selectedRun.pageElements.length} 个可操作元素</small>
                  </div>
                  {selectedRun.pageExcerpt ? (
                    <pre>{selectedRun.pageExcerpt}</pre>
                  ) : (
                    <div className="assistant-browser-page-empty">
                      确认“打开页面”后，这里会显示服务端读取到的可见文字。
                    </div>
                  )}
                </div>

                <div className="assistant-browser-step-history">
                  <div className="assistant-browser-page-heading">
                    <span>
                      <Clock3 size={14} />
                      <strong>步骤记录</strong>
                    </span>
                    <small>{selectedRun.steps.length}/30</small>
                  </div>
                  {selectedRun.steps.map((step) => (
                    <article key={step.id} className={`is-${step.status.toLowerCase()}`}>
                      <span className="assistant-browser-step-icon">{actionIcon(step.action)}</span>
                      <div>
                        <strong>
                          {step.sequence}. {ACTION_LABEL[step.action]}
                        </strong>
                        <small>
                          {step.status === "AWAITING_CONFIRMATION"
                            ? "等待确认"
                            : step.status === "RUNNING"
                              ? "执行中"
                              : step.status === "SUCCEEDED"
                                ? `完成于 ${formatClock(step.completedAt ?? step.createdAt)}`
                                : step.errorMessage || "已取消"}
                        </small>
                        {step.artifact && (
                          <a
                            href={`/api/files/${step.artifact.attachment.id}/content`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <FileImage size={13} />
                            {step.artifact.attachment.originalName}
                            <small>{formatBytes(step.artifact.attachment.sizeBytes)}</small>
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
