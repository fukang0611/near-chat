import {
  Activity,
  BrainCircuit,
  Check,
  CircleOff,
  ClipboardList,
  KeyRound,
  LoaderCircle,
  LogOut,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AdminUser, AiCapabilities, AuditLog, User } from "../types";
import { formatSidebarTime } from "../utils/format";
import { errorMessage } from "../utils/errors";
import { Avatar } from "./Avatar";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { ConnectorSettingsPanel } from "./ConnectorSettingsPanel";

type NoticeTone = "success" | "error" | "info";

interface AdminPanelProps {
  currentUser: User;
  onClose: () => void;
  onNotify: (message: string, tone?: NoticeTone) => void;
  onAiCapabilitiesChanged: (capabilities: AiCapabilities) => void;
}

export function AdminPanel({
  currentUser,
  onClose,
  onNotify,
  onAiCapabilitiesChanged,
}: AdminPanelProps) {
  const [view, setView] = useState<"users" | "ai" | "connectors" | "logs">("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [forceTarget, setForceTarget] = useState<AdminUser | null>(null);
  const [forcing, setForcing] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.adminUsers();
      setUsers(result.users);
    } catch (error) {
      onNotify(errorMessage(error, "用户列表加载失败"), "error");
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const result = await api.auditLogs();
      setLogs(result.logs);
    } catch (error) {
      onNotify(errorMessage(error, "操作日志加载失败"), "error");
    } finally {
      setLoadingLogs(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view === "logs") void loadLogs();
  }, [loadLogs, view]);

  useEffect(() => {
    // 抽屉和二级重置面板共用一套 Esc/Tab 规则，避免焦点逃到背景页面。
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (forceTarget) {
          setForceTarget(null);
        } else if (resetTarget) {
          setResetTarget(null);
          setResetPassword("");
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [
        ...drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [forceTarget, onClose, resetTarget]);

  const stats = useMemo(
    () => ({
      total: users.length,
      online: users.filter((item) => item.enabled && item.online).length,
      disabled: users.filter((item) => !item.enabled).length,
    }),
    [users],
  );

  const visibleUsers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return [...users]
      .filter(
        (item) =>
          !keyword ||
          item.displayName.toLowerCase().includes(keyword) ||
          item.username.toLowerCase().includes(keyword),
      )
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          Number(right.online) - Number(left.online) ||
          left.displayName.localeCompare(right.displayName, "zh-CN"),
      );
  }, [search, users]);

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      await api.createUser({ username, displayName, password, role: "USER" });
      const createdName = displayName;
      setUsername("");
      setDisplayName("");
      setPassword("");
      await load();
      onNotify(`${createdName} 的账号已创建`, "success");
    } catch (error) {
      onNotify(errorMessage(error, "创建用户失败"), "error");
    } finally {
      setCreating(false);
    }
  };

  const toggleUser = async (target: AdminUser) => {
    try {
      const result = await api.updateUser(target.id, { enabled: !target.enabled });
      setUsers((current) =>
        current.map((item) => (item.id === target.id ? { ...item, ...result.user } : item)),
      );
      onNotify(`${target.displayName} 已${result.user.enabled ? "启用" : "禁用"}`, "success");
    } catch (error) {
      onNotify(errorMessage(error, "用户状态更新失败"), "error");
    }
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetTarget) return;
    setResetting(true);
    try {
      await api.resetPassword(resetTarget.id, resetPassword);
      onNotify(`${resetTarget.displayName} 的密码已重置`, "success");
      setResetTarget(null);
      setResetPassword("");
    } catch (error) {
      onNotify(errorMessage(error, "密码重置失败"), "error");
    } finally {
      setResetting(false);
    }
  };

  const forceLogout = async () => {
    if (!forceTarget) return;
    setForcing(true);
    try {
      await api.forceLogout(forceTarget.id);
      setUsers((current) =>
        current.map((item) => (item.id === forceTarget.id ? { ...item, online: false } : item)),
      );
      onNotify(`${forceTarget.displayName} 的所有会话已退出`, "success");
      setForceTarget(null);
      if (view === "logs") await loadLogs();
    } catch (error) {
      onNotify(errorMessage(error, "强制退出失败"), "error");
    } finally {
      setForcing(false);
    }
  };

  const auditLabels: Record<string, string> = {
    ADMIN_USER_CREATE: "创建用户",
    ADMIN_USER_UPDATE: "更新用户",
    ADMIN_PASSWORD_RESET: "重置密码",
    ADMIN_FORCE_LOGOUT: "强制退出",
    PROFILE_UPDATE: "修改个人资料",
    PASSWORD_CHANGE: "修改密码",
    GROUP_CREATE: "创建群聊",
    GROUP_PROFILE_UPDATE: "修改群资料",
    GROUP_MEMBERS_ADD: "添加群成员",
    GROUP_MEMBER_REMOVE: "移出群成员",
    GROUP_OWNER_TRANSFER: "转让群主",
    GROUP_LEAVE: "退出群聊",
    GROUP_DISBAND: "解散群聊",
    ADMIN_AI_SETTINGS_UPDATE: "更新 AI 设置",
    ADMIN_AI_MODEL_CREATE: "添加 AI 模型",
    ADMIN_AI_MODEL_UPDATE: "更新 AI 模型",
    ADMIN_AI_MODEL_DELETE: "删除 AI 模型",
    CONNECTOR_CONFIG_CREATE: "创建连接器",
    CONNECTOR_CONFIG_UPDATE: "更新连接器",
    CONNECTOR_CONFIG_DELETE: "删除连接器",
    CONNECTOR_DELIVERY_QUEUE: "创建外部投递",
    CONNECTOR_IDENTITY_MAP: "映射外部身份",
    CONNECTOR_BINDING_SAVE: "保存会话绑定",
    CONNECTOR_BINDING_DELETE: "删除会话绑定",
    CONNECTOR_EVENT_RETRY: "重试入站事件",
    CONNECTOR_EVENT_CANCEL: "取消入站事件",
    CONNECTOR_JOB_RETRY: "重试主动投递",
    CONNECTOR_JOB_CANCEL: "取消主动投递",
  };

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        ref={drawerRef}
        className={`admin-drawer ${view === "ai" ? "is-ai-view" : ""} ${view === "connectors" ? "is-connector-view" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <span className="drawer-icon">
              <ShieldCheck size={19} />
            </span>
            <div>
              <strong id="admin-drawer-title">管理中心</strong>
              <small>管理账号、AI 服务、外部连接器与操作记录</small>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭用户管理">
            <X size={20} />
          </button>
        </header>

        <div className="drawer-content">
          {view === "users" && (
            <div className="admin-stats" aria-label="用户状态摘要">
              <div>
                <UsersRound size={17} />
                <span>
                  <strong>{stats.total}</strong>
                  <small>全部账号</small>
                </span>
              </div>
              <div>
                <Activity size={17} />
                <span>
                  <strong>{stats.online}</strong>
                  <small>当前在线</small>
                </span>
              </div>
              <div>
                <CircleOff size={17} />
                <span>
                  <strong>{stats.disabled}</strong>
                  <small>已禁用</small>
                </span>
              </div>
            </div>
          )}

          <div className="admin-tabs" role="tablist" aria-label="管理中心导航">
            <button
              type="button"
              role="tab"
              aria-selected={view === "connectors"}
              className={view === "connectors" ? "is-active" : ""}
              onClick={() => setView("connectors")}
            >
              <PlugZap size={15} /> 连接器
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "ai"}
              className={view === "ai" ? "is-active" : ""}
              onClick={() => setView("ai")}
            >
              <BrainCircuit size={15} /> AI 设置
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "users"}
              className={view === "users" ? "is-active" : ""}
              onClick={() => setView("users")}
            >
              <UsersRound size={15} /> 用户与会话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "logs"}
              className={view === "logs" ? "is-active" : ""}
              onClick={() => setView("logs")}
            >
              <ClipboardList size={15} /> 操作日志
            </button>
          </div>

          {view === "users" ? (
            <>
              <form className="create-user-card" onSubmit={createUser}>
                <div className="create-user-heading">
                  <span className="section-title">
                    <UserPlus size={17} />
                    添加局域网用户
                  </span>
                  <p>创建后即可使用用户名和初始密码登录</p>
                </div>
                <div className="compact-fields">
                  <label>
                    <span>显示名称</span>
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="例如：陈小北"
                      required
                    />
                  </label>
                  <label>
                    <span>登录用户名</span>
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="字母、数字或下划线"
                      minLength={3}
                      required
                    />
                  </label>
                  <label className="wide-field">
                    <span>初始密码</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 6 位，建议包含数字与字母"
                      minLength={6}
                      required
                    />
                  </label>
                </div>
                <button
                  className="primary-small"
                  type="submit"
                  disabled={
                    creating || !displayName.trim() || !username.trim() || password.length < 6
                  }
                >
                  {creating ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}
                  {creating ? "正在创建" : "创建账号"}
                </button>
              </form>

              <div className="admin-user-list">
                <div className="admin-list-toolbar">
                  <div className="section-caption">全部账号</div>
                  <label className="admin-search">
                    <Search size={15} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索账号"
                      aria-label="搜索账号"
                    />
                    {search && (
                      <button type="button" onClick={() => setSearch("")} aria-label="清除搜索">
                        <X size={13} />
                      </button>
                    )}
                  </label>
                </div>
                {loading ? (
                  <div className="drawer-loading">
                    <LoaderCircle className="spin" size={22} />
                    正在加载账号
                  </div>
                ) : visibleUsers.length === 0 ? (
                  <div className="admin-empty">
                    <Search size={21} />
                    <span>没有匹配的账号</span>
                  </div>
                ) : (
                  visibleUsers.map((target) => (
                    <div
                      className={`admin-user-row ${target.enabled ? "" : "is-disabled"}`}
                      key={target.id}
                    >
                      <Avatar
                        name={target.displayName}
                        color={target.avatarColor}
                        src={target.avatarUrl}
                        online={target.enabled ? target.online : false}
                      />
                      <div className="admin-user-copy">
                        <strong>
                          {target.displayName}
                          {target.role === "ADMIN" && (
                            <span className="role-badge">
                              <ShieldCheck size={11} />
                              管理员
                            </span>
                          )}
                          {target.id === currentUser.id && (
                            <span className="current-badge">当前账号</span>
                          )}
                        </strong>
                        <span>
                          @{target.username} ·{" "}
                          {target.enabled ? (target.online ? "在线" : "离线") : "已禁用"}
                        </span>
                      </div>
                      <div className="admin-row-actions">
                        <button
                          className="force-action"
                          type="button"
                          onClick={() => {
                            setResetTarget(null);
                            setForceTarget(target);
                          }}
                          disabled={target.id === currentUser.id}
                          aria-label={`强制退出 ${target.displayName} 的所有会话`}
                        >
                          <LogOut size={15} />
                          <span>退出</span>
                        </button>
                        <button
                          className="reset-action"
                          type="button"
                          onClick={() => {
                            setForceTarget(null);
                            setResetTarget(target);
                          }}
                          aria-label={`重置 ${target.displayName} 的密码`}
                        >
                          <KeyRound size={15} />
                          <span>密码</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleUser(target)}
                          disabled={target.id === currentUser.id}
                          aria-label={
                            target.enabled
                              ? `禁用 ${target.displayName}`
                              : `启用 ${target.displayName}`
                          }
                          aria-pressed={target.enabled}
                          className={`account-switch ${target.enabled ? "is-on" : ""}`}
                        >
                          <span />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : view === "logs" ? (
            <div className="admin-audit-list">
              <div className="admin-list-toolbar">
                <div className="section-caption">最近 100 条操作</div>
                <button
                  type="button"
                  className="audit-refresh"
                  onClick={() => void loadLogs()}
                  disabled={loadingLogs}
                >
                  <RefreshCw className={loadingLogs ? "spin" : ""} size={14} />
                  刷新
                </button>
              </div>
              {loadingLogs ? (
                <div className="drawer-loading">
                  <LoaderCircle className="spin" size={22} /> 正在加载操作日志
                </div>
              ) : logs.length === 0 ? (
                <div className="admin-empty">
                  <ClipboardList size={22} />
                  <span>暂无操作记录</span>
                </div>
              ) : (
                logs.map((log) => {
                  const subject =
                    typeof log.details.username === "string"
                      ? `@${log.details.username}`
                      : typeof log.details.name === "string"
                        ? `“${log.details.name}”`
                        : log.targetId
                          ? `#${log.targetId.slice(0, 8)}`
                          : "系统对象";
                  return (
                    <div className="audit-row" key={log.id}>
                      <span className="audit-icon">
                        <ClipboardList size={15} />
                      </span>
                      <span>
                        <strong>
                          {log.actor?.displayName ?? "系统"} ·{" "}
                          {auditLabels[log.action] ?? log.action}
                        </strong>
                        <small>{subject}</small>
                      </span>
                      <time dateTime={log.createdAt}>{formatSidebarTime(log.createdAt)}</time>
                    </div>
                  );
                })
              )}
            </div>
          ) : view === "connectors" ? (
            <ConnectorSettingsPanel currentUser={currentUser} users={users} onNotify={onNotify} />
          ) : (
            <AiSettingsPanel onNotify={onNotify} onCapabilitiesChanged={onAiCapabilitiesChanged} />
          )}
        </div>

        {resetTarget && (
          <form className="reset-panel" onSubmit={reset}>
            <div className="reset-heading">
              <span className="reset-icon">
                <KeyRound size={17} />
              </span>
              <div>
                <strong>重置 {resetTarget.displayName} 的密码</strong>
                <small>保存后，该用户的现有登录会立即失效</small>
              </div>
            </div>
            <label>
              <span>新密码</span>
              <input
                autoFocus
                type="password"
                minLength={6}
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
                placeholder="至少输入 6 个字符"
                required
              />
            </label>
            <div className="reset-actions">
              <button type="button" onClick={() => setResetTarget(null)}>
                取消
              </button>
              <button type="submit" disabled={resetting || resetPassword.length < 6}>
                {resetting ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
                确认重置
              </button>
            </div>
          </form>
        )}
        {forceTarget && (
          <div className="reset-panel force-panel" role="alertdialog" aria-modal="true">
            <div className="reset-heading">
              <span className="reset-icon">
                <LogOut size={17} />
              </span>
              <div>
                <strong>强制退出 {forceTarget.displayName}？</strong>
                <small>该账号在所有设备上的令牌与实时连接都会立即失效</small>
              </div>
            </div>
            <div className="reset-actions">
              <button type="button" onClick={() => setForceTarget(null)} disabled={forcing}>
                取消
              </button>
              <button type="button" onClick={() => void forceLogout()} disabled={forcing}>
                {forcing ? <LoaderCircle className="spin" size={14} /> : <LogOut size={14} />}
                确认退出
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
