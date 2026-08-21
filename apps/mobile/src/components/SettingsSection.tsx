import { FormEvent, useEffect, useState } from "react";
import type { MobileSyncState, SyncProfile } from "../models";
import { networkPolicy, secureGet, secureSet } from "../native";
import { connectWithToken, loginToTeam } from "../sync";
import { normalizeModelBaseUrl } from "../sync-logic";

interface Props {
  accountKey: string;
  profile: SyncProfile | null;
  syncState: MobileSyncState;
  onConnected(profile: SyncProfile): Promise<void>;
  onLogout(): Promise<void>;
  onSync(): Promise<void>;
}

export function SettingsSection({
  accountKey,
  profile,
  syncState,
  onConnected,
  onLogout,
  onSync,
}: Props) {
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [serverUrl, setServerUrl] = useState(profile?.serverUrl ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [manualToken, setManualToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cleartextWarning, setCleartextWarning] = useState("");
  const [modelCleartextWarning, setModelCleartextWarning] = useState("");
  const [modelCleartextBlocked, setModelCleartextBlocked] = useState(false);

  useEffect(() => {
    void Promise.all([
      secureGet("model-base-url"),
      secureGet("model-name"),
      secureGet("model-api-key"),
    ]).then(([baseUrl, name, apiKey]) => {
      setModelBaseUrl(baseUrl ?? "");
      setModelName(name ?? "");
      setModelKey(apiKey ?? "");
    });
  }, []);

  useEffect(() => {
    setServerUrl(profile?.serverUrl ?? serverUrl);
    setUsername(profile?.username ?? username);
  }, [profile?.serverUrl, profile?.username]);

  useEffect(() => {
    if (!serverUrl.trim().toLocaleLowerCase().startsWith("http://")) {
      setCleartextWarning("");
      return;
    }
    void networkPolicy().then((policy) => {
      setCleartextWarning(
        policy.allowCleartext
          ? "当前为调试构建：允许局域网 HTTP，但登录密码和 Bearer 会明文传输，仅用于可信测试网。"
          : "正式构建禁止 HTTP；请为 NearChat 配置 HTTPS。",
      );
    });
  }, [serverUrl]);

  useEffect(() => {
    if (!modelBaseUrl.trim().toLocaleLowerCase().startsWith("http://")) {
      setModelCleartextWarning("");
      setModelCleartextBlocked(false);
      return;
    }
    void networkPolicy().then((policy) => {
      setModelCleartextBlocked(!policy.allowCleartext);
      setModelCleartextWarning(
        policy.allowCleartext
          ? "当前为调试构建：模型 API Key 会通过明文 HTTP 发送，仅可用于可信测试网。"
          : "正式构建禁止通过 HTTP 发送模型 API Key；请使用 HTTPS 模型地址。",
      );
    });
  }, [modelBaseUrl]);

  const saveModel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const policy = await networkPolicy();
      const normalizedBaseUrl = normalizeModelBaseUrl(modelBaseUrl, policy.allowCleartext);
      if (modelCleartextBlocked) {
        setMessage("正式构建不能保存明文 HTTP 模型地址，请改用 HTTPS");
        return;
      }
      await Promise.all([
        secureSet("model-base-url", normalizedBaseUrl),
        secureSet("model-name", modelName.trim()),
        secureSet("model-api-key", modelKey.trim()),
      ]);
      setModelBaseUrl(normalizedBaseUrl);
      setMessage("模型配置已保存到设备安全存储");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "模型配置无效");
    }
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setMessage("正在登录…");
    try {
      const next = await loginToTeam(serverUrl, username, password, accountKey);
      await onConnected(next);
      setMessage(`已登录 ${next.username} 并完成同步`);
      event.currentTarget.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const useToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("正在验证令牌…");
    try {
      const next = await connectWithToken(serverUrl, manualToken, accountKey);
      await onConnected(next);
      setManualToken("");
      setMessage(`已验证 ${next.username} 并完成同步`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "令牌验证失败");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("正在安全退出…");
    try {
      await onLogout();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>我的</h1>
      <h2>本地模型</h2>
      <form onSubmit={saveModel}>
        <label>
          OpenAI 兼容地址
          <input
            value={modelBaseUrl}
            onChange={(event) => setModelBaseUrl(event.target.value)}
            placeholder="https://…/v1"
            required
          />
        </label>
        {modelCleartextWarning && <small className="warning-text">{modelCleartextWarning}</small>}
        <label>
          模型名
          <input
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            placeholder="例如 gpt-4.1-mini"
            required
          />
        </label>
        <label>
          API Key
          <input
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            type="password"
            autoComplete="off"
            placeholder="仅保存在 Android Keystore"
            required
          />
        </label>
        <button disabled={modelCleartextBlocked}>安全保存模型配置</button>
      </form>

      <h2>团队账号</h2>
      {profile ? (
        <div className="settings-card">
          <strong>{profile.username}</strong>
          <p>{profile.serverUrl}</p>
          <small>{syncState.message}</small>
          <div className="button-row">
            <button onClick={() => void onSync()} disabled={syncState.phase === "SYNCING"}>
              立即同步
            </button>
            <button className="danger" onClick={() => void logout()} disabled={busy}>
              {busy ? "正在处理…" : "退出账号"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={login}>
          <label>
            团队地址
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://near-chat.example"
              required
            />
          </label>
          {cleartextWarning && <small className="warning-text">{cleartextWarning}</small>}
          <label>
            用户名
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button disabled={busy}>{busy ? "正在连接…" : "登录并同步"}</button>
        </form>
      )}

      {!profile && (
        <details>
          <summary>高级：使用现有令牌</summary>
          <form onSubmit={useToken}>
            <p className="hint">
              令牌会先通过 /api/auth/me 验证，再写入 Keystore；不能替代常规账号登录。
            </p>
            <input
              value={manualToken}
              onChange={(event) => setManualToken(event.target.value)}
              type="password"
              placeholder="Bearer Token"
              required
            />
            <button disabled={busy}>验证令牌</button>
          </form>
        </details>
      )}
      {message && <p className="status-message">{message}</p>}
      <p className="hint">
        游标和 outbox 按服务器、用户、设备三重命名空间隔离；模型密钥永不进入同步。
      </p>
    </section>
  );
}
