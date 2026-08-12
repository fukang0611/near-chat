import {
  Activity,
  Check,
  CircleOff,
  KeyRound,
  LoaderCircle,
  Search,
  ShieldCheck,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AdminUser, User } from "../types";
import { errorMessage } from "../utils/errors";
import { Avatar } from "./Avatar";

type NoticeTone = "success" | "error" | "info";

interface AdminPanelProps {
  currentUser: User;
  onClose: () => void;
  onNotify: (message: string, tone?: NoticeTone) => void;
}

export function AdminPanel({ currentUser, onClose, onNotify }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
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

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // 抽屉和二级重置面板共用一套 Esc/Tab 规则，避免焦点逃到背景页面。
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (resetTarget) {
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
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onClose, resetTarget]);

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

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        ref={drawerRef}
        className="admin-drawer"
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
              <strong id="admin-drawer-title">用户管理</strong>
              <small>创建账号并管理局域网访问权限</small>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭用户管理">
            <X size={20} />
          </button>
        </header>

        <div className="drawer-content">
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
              disabled={creating || !displayName.trim() || !username.trim() || password.length < 6}
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
                      className="reset-action"
                      type="button"
                      onClick={() => setResetTarget(target)}
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
                        target.enabled ? `禁用 ${target.displayName}` : `启用 ${target.displayName}`
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
      </aside>
    </div>
  );
}
