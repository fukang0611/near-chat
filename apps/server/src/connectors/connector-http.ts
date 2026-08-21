export const CONNECTOR_HTTP_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CONNECTOR_HTTP_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("连接器请求超时")), timeoutMs);
  timer.unref();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonResponse(
  response: Response,
): Promise<{ errcode?: number; errmsg?: string; [key: string]: unknown }> {
  if (!response.ok) throw new Error(`外部平台返回 HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("外部平台没有返回 JSON");
  }
  return (await response.json()) as {
    errcode?: number;
    errmsg?: string;
    [key: string]: unknown;
  };
}
