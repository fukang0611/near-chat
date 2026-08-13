import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  MessageCircleMore,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import { errorMessage } from "../utils/errors";
import type { ThemeMode } from "../utils/theme";
import { LoginNetworkVisual } from "./LoginNetworkVisual";
import { ThemeToggle } from "./ThemeToggle";

interface LoginPageProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  onLogin: (token: string, user: User) => void;
}

export function LoginPage({ theme, onThemeChange, onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await api.login(username, password);
      onLogin(result.token, result.user);
    } catch (caught) {
      setError(errorMessage(caught, "登录失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemo = (name: string, secret: string) => {
    setUsername(name);
    setPassword(secret);
    setError("");
  };

  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"));
  };

  return (
    <main className="login-page">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="login-shell">
        <div className="window-dots" aria-hidden="true">
          <i className="dot-red" />
          <i className="dot-yellow" />
          <i className="dot-green" />
        </div>
        <ThemeToggle theme={theme} onChange={onThemeChange} className="login-theme-toggle" />

        <div className="login-intro">
          <div className="brand-lockup">
            <span className="brand-mark">
              <MessageCircleMore size={22} />
            </span>
            <span>
              近聊 <small>NearChat</small>
            </span>
          </div>
          <div className="login-story">
            <LoginNetworkVisual />
          </div>
          <div className="intro-status">
            <span className="status-pulse" />
            <span>
              <strong>服务已就绪</strong>消息与文件只在你的局域网内流转
            </span>
          </div>
        </div>

        <div className="login-form-wrap">
          <form className="login-form" onSubmit={submit}>
            <div className="form-heading">
              <span>欢迎回来</span>
              <p>使用管理员分配的账号登录</p>
            </div>

            <div className="input-field">
              <label htmlFor="login-username">用户名</label>
              <div>
                <UserRound size={18} />
                <input
                  id="login-username"
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="请输入用户名"
                />
              </div>
            </div>

            <div className="input-field">
              <label htmlFor="login-password">密码</label>
              <div>
                <LockKeyhole size={18} />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={updateCapsLock}
                  onKeyUp={updateCapsLock}
                  placeholder="请输入密码"
                />
                <button
                  type="button"
                  className="password-visibility"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {capsLock && <small className="caps-hint">大写锁定已开启</small>}
            </div>

            {error && (
              <div className="form-error" role="alert">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <button
              className="login-button"
              type="submit"
              disabled={submitting || !username.trim() || !password}
            >
              <span>{submitting ? "正在进入…" : "进入近聊"}</span>
              {submitting ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}
            </button>

            <div className="demo-accounts">
              <span>本地演示账号</span>
              <div>
                <button type="button" onClick={() => fillDemo("admin", "admin123")}>
                  <ShieldCheck size={13} />
                  管理员
                </button>
                <button type="button" onClick={() => fillDemo("alice", "alice123")}>
                  <i className="demo-dot alice" />
                  林小满
                </button>
                <button type="button" onClick={() => fillDemo("bob", "bob123")}>
                  <i className="demo-dot bob" />
                  周远
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
