import {
  Activity,
  Ban,
  CircleAlert,
  Clock3,
  Inbox,
  LoaderCircle,
  Link2,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type {
  ConnectorConfig,
  ConnectorEventStatus,
  ConnectorJobStatus,
  ConnectorOperationEvent,
  ConnectorOperationJob,
  ConnectorOperationsHealth,
  ConnectorOperationsCursor,
} from "../types";
import { errorMessage } from "../utils/errors";
import {
  connectorEventStatuses,
  connectorJobStatuses,
  connectorOperationStatusLabels,
  formatOperationTime,
  safeConnectorOperationError,
} from "./connector-operations-model";

type NoticeTone = "success" | "error" | "info";
type OperationAction = "retry" | "cancel";
type OperationTarget =
  { type: "event"; item: ConnectorOperationEvent } | { type: "job"; item: ConnectorOperationJob };

interface ConnectorOperationsPanelProps {
  connectors: ConnectorConfig[];
  onNotify: (message: string, tone?: NoticeTone) => void;
  onCreateBinding: (event: ConnectorOperationEvent) => void | Promise<void>;
}

function operationCanRetry(target: OperationTarget): boolean {
  return target.item.status === "FAILED" || target.item.status === "CANCELLED";
}

function operationCanCancel(target: OperationTarget): boolean {
  if (target.type === "event") {
    return target.item.status === "FAILED" || target.item.status === "RECEIVED";
  }
  return target.item.status === "FAILED" || target.item.status === "QUEUED";
}

function appendUniqueById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !known.has(item.id))];
}

export function ConnectorOperationsPanel({
  connectors,
  onNotify,
  onCreateBinding,
}: ConnectorOperationsPanelProps) {
  const [health, setHealth] = useState<ConnectorOperationsHealth | null>(null);
  const [events, setEvents] = useState<ConnectorOperationEvent[]>([]);
  const [jobs, setJobs] = useState<ConnectorOperationJob[]>([]);
  const [connectorId, setConnectorId] = useState("");
  const [eventStatus, setEventStatus] = useState<ConnectorEventStatus>("FAILED");
  const [jobStatus, setJobStatus] = useState<ConnectorJobStatus>("FAILED");
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [loadingMoreJobs, setLoadingMoreJobs] = useState(false);
  const [eventNextCursor, setEventNextCursor] = useState<ConnectorOperationsCursor | null>(null);
  const [jobNextCursor, setJobNextCursor] = useState<ConnectorOperationsCursor | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    action: OperationAction;
    target: OperationTarget;
  } | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [openingBindingId, setOpeningBindingId] = useState<string | null>(null);
  const healthRequestRef = useRef(0);
  const eventRequestRef = useRef(0);
  const jobRequestRef = useRef(0);

  const loadHealth = useCallback(async () => {
    const requestId = ++healthRequestRef.current;
    setLoadingHealth(true);
    setHealthError(null);
    try {
      const result = await api.connectorOperationsHealth();
      if (requestId === healthRequestRef.current) setHealth(result.health);
    } catch (error) {
      if (requestId === healthRequestRef.current) {
        setHealthError(errorMessage(error, "连接器健康状态加载失败"));
      }
    } finally {
      if (requestId === healthRequestRef.current) setLoadingHealth(false);
    }
  }, []);

  const loadEvents = useCallback(
    async (cursor: ConnectorOperationsCursor | null = null) => {
      const requestId = ++eventRequestRef.current;
      if (cursor) setLoadingMoreEvents(true);
      else {
        setLoadingEvents(true);
        setLoadingMoreEvents(false);
        setEventNextCursor(null);
      }
      setEventError(null);
      try {
        const result = await api.connectorOperationEvents({
          status: eventStatus,
          limit: 50,
          ...(connectorId ? { connectorId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (requestId === eventRequestRef.current) {
          setEvents((current) =>
            cursor ? appendUniqueById(current, result.events) : result.events,
          );
          setEventNextCursor(result.nextCursor);
        }
      } catch (error) {
        if (requestId === eventRequestRef.current) {
          setEventError(errorMessage(error, "入站事件列表加载失败"));
        }
      } finally {
        if (requestId === eventRequestRef.current) {
          if (cursor) setLoadingMoreEvents(false);
          else setLoadingEvents(false);
        }
      }
    },
    [connectorId, eventStatus],
  );

  const loadJobs = useCallback(
    async (cursor: ConnectorOperationsCursor | null = null) => {
      const requestId = ++jobRequestRef.current;
      if (cursor) setLoadingMoreJobs(true);
      else {
        setLoadingJobs(true);
        setLoadingMoreJobs(false);
        setJobNextCursor(null);
      }
      setJobError(null);
      try {
        const result = await api.connectorOperationJobs({
          status: jobStatus,
          limit: 50,
          ...(connectorId ? { connectorId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (requestId === jobRequestRef.current) {
          setJobs((current) => (cursor ? appendUniqueById(current, result.jobs) : result.jobs));
          setJobNextCursor(result.nextCursor);
        }
      } catch (error) {
        if (requestId === jobRequestRef.current) {
          setJobError(errorMessage(error, "主动投递列表加载失败"));
        }
      } finally {
        if (requestId === jobRequestRef.current) {
          if (cursor) setLoadingMoreJobs(false);
          else setLoadingJobs(false);
        }
      }
    },
    [connectorId, jobStatus],
  );

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(
    () => () => {
      healthRequestRef.current += 1;
      eventRequestRef.current += 1;
      jobRequestRef.current += 1;
    },
    [],
  );

  const refreshAll = () => {
    void Promise.all([loadHealth(), loadEvents(), loadJobs()]);
  };

  const executeAction = async () => {
    if (!confirm) return;
    const { action, target } = confirm;
    setActingId(target.item.id);
    try {
      if (target.type === "event") {
        if (action === "retry") await api.retryConnectorOperationEvent(target.item.id);
        else await api.cancelConnectorOperationEvent(target.item.id);
      } else if (action === "retry") {
        await api.retryConnectorOperationJob(target.item.id);
      } else {
        await api.cancelConnectorOperationJob(target.item.id);
      }
      onNotify(
        `${target.type === "event" ? "入站事件" : "主动投递"}已${action === "retry" ? "重新排队" : "取消"}`,
        "success",
      );
      setConfirm(null);
      await Promise.all([loadHealth(), target.type === "event" ? loadEvents() : loadJobs()]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        onNotify("操作状态已变化，已刷新最新队列", "error");
        setConfirm(null);
        await Promise.all([loadHealth(), loadEvents(), loadJobs()]);
      } else {
        onNotify(errorMessage(error, action === "retry" ? "重新排队失败" : "取消失败"), "error");
      }
    } finally {
      setActingId(null);
    }
  };

  const openBinding = async (event: ConnectorOperationEvent) => {
    setOpeningBindingId(event.id);
    try {
      await onCreateBinding(event);
    } finally {
      setOpeningBindingId(null);
    }
  };

  const renderActions = (target: OperationTarget) => (
    <span className="connector-operation-actions">
      {target.type === "event" && target.item.externalConversationId && (
        <button
          type="button"
          onClick={() => void openBinding(target.item)}
          disabled={openingBindingId !== null}
          aria-label={`配置事件会话绑定 ${target.item.id.slice(0, 8)}`}
        >
          {openingBindingId === target.item.id ? (
            <LoaderCircle className="spin" size={12} />
          ) : (
            <Link2 size={12} />
          )}
          配置绑定
        </button>
      )}
      {operationCanRetry(target) && (
        <button
          type="button"
          onClick={() => setConfirm({ action: "retry", target })}
          disabled={actingId === target.item.id}
          aria-label={`重试 ${target.type === "event" ? "事件" : "投递"} ${target.item.id.slice(0, 8)}`}
        >
          <RotateCcw size={12} /> 重试
        </button>
      )}
      {operationCanCancel(target) && (
        <button
          type="button"
          onClick={() => setConfirm({ action: "cancel", target })}
          disabled={actingId === target.item.id}
          aria-label={`取消 ${target.type === "event" ? "事件" : "投递"} ${target.item.id.slice(0, 8)}`}
        >
          <Ban size={12} /> 取消
        </button>
      )}
    </span>
  );

  return (
    <section className="connector-operations-panel" aria-label="连接器运维">
      <header className="connector-operations-heading">
        <div>
          <span className="connector-provider-icon">
            <Activity size={17} />
          </span>
          <span>
            <strong>故障与恢复</strong>
            <small>这里只展示裁剪后的运行摘要，不读取消息正文、模型结果或外部密钥</small>
          </span>
        </div>
        <label>
          <span>连接器</span>
          <select value={connectorId} onChange={(event) => setConnectorId(event.target.value)}>
            <option value="">全部连接器</option>
            {connectors.map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={refreshAll}>
          <RefreshCw
            className={loadingHealth || loadingEvents || loadingJobs ? "spin" : ""}
            size={13}
          />
          全部刷新
        </button>
      </header>

      {healthError ? (
        <div className="connector-error" role="alert">
          <CircleAlert size={15} />
          <span>{healthError}</span>
          <button type="button" onClick={() => void loadHealth()}>
            重试
          </button>
        </div>
      ) : (
        <div className="connector-health-grid" aria-label="全局队列健康度">
          <div className="connector-health-scope">
            <strong>全局队列健康度</strong>
            <small>不受上方连接器筛选影响</small>
          </div>
          <article className={(health?.events.counts.FAILED ?? 0) > 0 ? "has-failures" : ""}>
            <Inbox size={16} />
            <span>
              <strong>{loadingHealth ? "—" : (health?.events.counts.FAILED ?? 0)}</strong>
              <small>全局失败入站事件</small>
            </span>
          </article>
          <article className={(health?.jobs.counts.FAILED ?? 0) > 0 ? "has-failures" : ""}>
            <Send size={16} />
            <span>
              <strong>{loadingHealth ? "—" : (health?.jobs.counts.FAILED ?? 0)}</strong>
              <small>全局失败主动投递</small>
            </span>
          </article>
          <article>
            <Activity size={16} />
            <span>
              <strong>
                {loadingHealth
                  ? "—"
                  : (health?.events.counts.PROCESSING ?? 0) + (health?.jobs.counts.RUNNING ?? 0)}
              </strong>
              <small>全局正在执行</small>
            </span>
          </article>
          <article>
            <ShieldCheck size={16} />
            <span>
              <strong>
                {loadingHealth ? "—" : (health?.events.total ?? 0) + (health?.jobs.total ?? 0)}
              </strong>
              <small>全局累计队列记录</small>
            </span>
          </article>
          <div className="connector-health-time">
            <Clock3 size={12} />
            全局健康统计 · 最近检查 {formatOperationTime(health?.checkedAt ?? null)} · 最早记录{" "}
            {formatOperationTime(
              [health?.events.oldestAt, health?.jobs.oldestAt]
                .filter((value): value is string => Boolean(value))
                .sort()[0] ?? null,
            )}
          </div>
        </div>
      )}

      <div className="connector-operation-columns">
        <section className="connector-operation-card">
          <header>
            <span>
              <Inbox size={14} />
              <strong>入站事件</strong>
            </span>
            <select
              aria-label="入站事件状态"
              value={eventStatus}
              onChange={(event) => setEventStatus(event.target.value as ConnectorEventStatus)}
            >
              {connectorEventStatuses.map((status) => (
                <option key={status} value={status}>
                  {connectorOperationStatusLabels[status]}
                </option>
              ))}
            </select>
          </header>
          {eventError ? (
            <div className="connector-error" role="alert">
              <CircleAlert size={14} />
              <span>{eventError}</span>
              <button type="button" onClick={() => void loadEvents()}>
                重试
              </button>
            </div>
          ) : loadingEvents ? (
            <div className="connector-operation-empty">
              <LoaderCircle className="spin" size={17} /> 正在加载入站事件
            </div>
          ) : events.length === 0 ? (
            <div className="connector-operation-empty">当前筛选条件下没有入站事件</div>
          ) : (
            <div className="connector-operation-list">
              {events.map((event) => {
                const target: OperationTarget = { type: "event", item: event };
                return (
                  <article key={event.id}>
                    <header>
                      <span>
                        <strong>{event.connectorName}</strong>
                        <small>
                          {event.kind} · #{event.id.slice(0, 8)} · 尝试 {event.attempts} 次
                        </small>
                      </span>
                      <em className={`status-${event.status.toLowerCase()}`}>
                        {connectorOperationStatusLabels[event.status]}
                      </em>
                    </header>
                    {event.status === "FAILED" && <p>{safeConnectorOperationError(event.error)}</p>}
                    <footer>
                      <span>
                        {formatOperationTime(event.receivedAt)}
                        {event.prepared ? " · 已缓存处理结果" : " · 尚未缓存处理结果"}
                      </span>
                      {renderActions(target)}
                    </footer>
                  </article>
                );
              })}
              {eventNextCursor && (
                <button
                  type="button"
                  className="connector-operation-load-more"
                  disabled={loadingMoreEvents}
                  onClick={() => void loadEvents(eventNextCursor)}
                >
                  {loadingMoreEvents && <LoaderCircle className="spin" size={12} />}
                  加载更早事件
                </button>
              )}
            </div>
          )}
        </section>

        <section className="connector-operation-card">
          <header>
            <span>
              <Send size={14} />
              <strong>主动投递</strong>
            </span>
            <select
              aria-label="主动投递状态"
              value={jobStatus}
              onChange={(event) => setJobStatus(event.target.value as ConnectorJobStatus)}
            >
              {connectorJobStatuses.map((status) => (
                <option key={status} value={status}>
                  {connectorOperationStatusLabels[status]}
                </option>
              ))}
            </select>
          </header>
          {jobError ? (
            <div className="connector-error" role="alert">
              <CircleAlert size={14} />
              <span>{jobError}</span>
              <button type="button" onClick={() => void loadJobs()}>
                重试
              </button>
            </div>
          ) : loadingJobs ? (
            <div className="connector-operation-empty">
              <LoaderCircle className="spin" size={17} /> 正在加载主动投递
            </div>
          ) : jobs.length === 0 ? (
            <div className="connector-operation-empty">当前筛选条件下没有主动投递</div>
          ) : (
            <div className="connector-operation-list">
              {jobs.map((job) => {
                const target: OperationTarget = { type: "job", item: job };
                return (
                  <article key={job.id}>
                    <header>
                      <span>
                        <strong>{job.connectorName}</strong>
                        <small>
                          {job.kind} · #{job.id.slice(0, 8)} · 尝试 {job.attempts} 次
                        </small>
                      </span>
                      <em className={`status-${job.status.toLowerCase()}`}>
                        {connectorOperationStatusLabels[job.status]}
                      </em>
                    </header>
                    {job.status === "FAILED" && <p>{safeConnectorOperationError(job.error)}</p>}
                    <footer>
                      <span>{formatOperationTime(job.updatedAt)}</span>
                      {renderActions(target)}
                    </footer>
                  </article>
                );
              })}
              {jobNextCursor && (
                <button
                  type="button"
                  className="connector-operation-load-more"
                  disabled={loadingMoreJobs}
                  onClick={() => void loadJobs(jobNextCursor)}
                >
                  {loadingMoreJobs && <LoaderCircle className="spin" size={12} />}
                  加载更早投递
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      {confirm && (
        <div className="connector-operation-confirm" role="alertdialog" aria-modal="true">
          <CircleAlert size={18} />
          <div>
            <strong>
              {confirm.action === "retry" ? "重新排队" : "取消"}
              {confirm.target.type === "event" ? "此入站事件" : "此主动投递"}？
            </strong>
            <small>
              {confirm.action === "retry"
                ? "重试可能再次触发外部发送；页面不读取或展示消息正文，操作会写入审计日志。"
                : "取消后工作进程将不再处理该项，必要时仍可从“已取消”筛选中重新排队。"}
            </small>
          </div>
          <span>
            <button type="button" onClick={() => setConfirm(null)} disabled={Boolean(actingId)}>
              返回
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void executeAction()}
              disabled={Boolean(actingId)}
            >
              {actingId ? (
                <LoaderCircle className="spin" size={13} />
              ) : confirm.action === "retry" ? (
                <RotateCcw size={13} />
              ) : (
                <Ban size={13} />
              )}
              确认{confirm.action === "retry" ? "重试" : "取消"}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
