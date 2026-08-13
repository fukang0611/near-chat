import { useCallback, useEffect, useState } from "react";
import { MessageCircleMore } from "lucide-react";
import { api, clearToken, getToken, saveToken } from "./api";
import { ChatPage } from "./components/ChatPage";
import { DesktopIslandPage, DesktopIslandSignedOut } from "./components/DesktopIslandPage";
import { LoginPage } from "./components/LoginPage";
import type { User } from "./types";
import { getCurrentTheme, setThemePreference, type ThemeMode } from "./utils/theme";

export default function App() {
  const isDesktopIsland = new URLSearchParams(window.location.search).get("desktopIsland") === "1";
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [theme, setTheme] = useState<ThemeMode>(getCurrentTheme);

  const changeTheme = useCallback((nextTheme: ThemeMode) => {
    setThemePreference(nextTheme);
    setTheme(nextTheme);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    // 页面刷新时用服务端重新校验令牌，而不是信任本地缓存的用户资料。
    void api
      .me()
      .then((result) => setUser(result.user))
      .catch(logout)
      .finally(() => setChecking(false));
  }, [logout]);

  useEffect(() => {
    if (!isDesktopIsland) return;
    const syncSharedLogin = () => {
      if (!getToken()) {
        setUser(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      void api
        .me()
        .then((result) => setUser(result.user))
        .catch(logout)
        .finally(() => setChecking(false));
    };
    window.addEventListener("storage", syncSharedLogin);
    return () => window.removeEventListener("storage", syncSharedLogin);
  }, [isDesktopIsland, logout]);

  if (checking) {
    return (
      <div className="app-boot" role="status" aria-label="正在连接近聊">
        <div className="boot-card">
          <span className="boot-logo">
            <MessageCircleMore size={24} />
          </span>
          <strong>近聊</strong>
          <small>正在恢复局域网连接</small>
          <span className="boot-progress">
            <i />
          </span>
        </div>
      </div>
    );
  }

  if (isDesktopIsland) {
    return user ? (
      <DesktopIslandPage user={user} onSessionInvalid={logout} />
    ) : (
      <DesktopIslandSignedOut />
    );
  }

  if (!user) {
    return (
      <LoginPage
        theme={theme}
        onThemeChange={changeTheme}
        onLogin={(token, nextUser) => {
          saveToken(token);
          setUser(nextUser);
        }}
      />
    );
  }

  return (
    <ChatPage
      user={user}
      theme={theme}
      onThemeChange={changeTheme}
      onUserUpdated={setUser}
      onLogout={logout}
    />
  );
}
