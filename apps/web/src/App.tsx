import { useCallback, useEffect, useState } from "react";
import { MessageCircleMore } from "lucide-react";
import { api, clearToken, getToken, saveToken } from "./api";
import { ChatPage } from "./components/ChatPage";
import { LoginPage } from "./components/LoginPage";
import type { User } from "./types";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));

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

  if (!user) {
    return (
      <LoginPage
        onLogin={(token, nextUser) => {
          saveToken(token);
          setUser(nextUser);
        }}
      />
    );
  }

  return <ChatPage user={user} onUserUpdated={setUser} onLogout={logout} />;
}
