export const DEFAULT_SERVER_URL = "http://127.0.0.1:3000";

/** 将用户输入收敛为服务端源地址，避免把 API 请求连接到意外的子路径。 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入近聊服务器地址");

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("服务器地址格式不正确");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("服务器地址仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) throw new Error("服务器地址不能包含账号或密码");
  if (!url.hostname) throw new Error("服务器地址缺少主机名或 IP");
  if (url.search || url.hash) throw new Error("服务器地址不能包含查询参数或锚点");
  if (url.pathname !== "/") throw new Error("服务器地址不能包含额外路径");

  return `${url.protocol}//${url.host}`;
}

export function serverHealthUrl(serverUrl: string): string {
  return new URL("/api/health", normalizeServerUrl(serverUrl)).toString();
}
