import { createHash } from "node:crypto";
import type { DWClientDownStream, RobotMessage } from "dingtalk-stream";
import type { ConnectorConfigPayload, ConnectorInboundTextMessage } from "./connector-provider.js";
import { fetchWithTimeout, readJsonResponse } from "./connector-http.js";

export interface DingTalkDeliveryRoute {
  conversationType: "1" | "2";
  robotCode: string;
  senderStaffId: string;
  openConversationId?: string;
}

export interface ParsedDingTalkText {
  message: ConnectorInboundTextMessage;
  sessionWebhook: string;
  sessionWebhookExpiresAt: string;
  deliveryRoute: DingTalkDeliveryRoute;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`钉钉机器人消息缺少 ${field}`);
  return value.trim();
}

function routeIdentifier(value: unknown, field: string): string {
  const normalized = required(value, field);
  if (normalized.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.:@+\-/=]{0,199}$/.test(normalized)) {
    throw new Error(`钉钉主动投递路由 ${field} 无效`);
  }
  return normalized;
}

/** 只接受企业机器人 CALLBACK 能证明的群聊/私聊路由，不允许任意对象进入 OpenAPI。 */
export function parseDingTalkDeliveryRoute(value: unknown): DingTalkDeliveryRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("钉钉主动投递缺少安全路由");
  }
  const route = value as Record<string, unknown>;
  if (route.conversationType !== "1" && route.conversationType !== "2") {
    throw new Error("钉钉主动投递 conversationType 只支持 1 或 2");
  }
  const parsed: DingTalkDeliveryRoute = {
    conversationType: route.conversationType,
    robotCode: routeIdentifier(route.robotCode, "robotCode"),
    senderStaffId: routeIdentifier(route.senderStaffId, "senderStaffId"),
  };
  if (parsed.conversationType === "2") {
    parsed.openConversationId = routeIdentifier(route.openConversationId, "openConversationId");
  }
  return parsed;
}

export function tryParseDingTalkDeliveryRoute(value: unknown): DingTalkDeliveryRoute | null {
  try {
    return parseDingTalkDeliveryRoute(value);
  } catch {
    return null;
  }
}

/** 机器人 CALLBACK 的 msgId 是平台业务幂等键，不能用每次投递都可能变化的本地 UUID。 */
export function parseDingTalkRobotText(
  connectorId: string,
  event: DWClientDownStream,
): ParsedDingTalkText | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data || "{}");
  } catch {
    throw new Error("钉钉机器人消息不是有效 JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("钉钉机器人消息格式不正确");
  const robot = raw as Partial<RobotMessage>;
  if (robot.msgtype !== "text") return null;
  const text = required(robot.text?.content, "text.content");
  const occurredAt = new Date(typeof robot.createAt === "number" ? robot.createAt : Date.now());
  const expiresAtValue = robot.sessionWebhookExpiredTime;
  if (typeof expiresAtValue !== "number" || !Number.isSafeInteger(expiresAtValue)) {
    throw new Error("钉钉机器人消息缺少有效的 sessionWebhookExpiredTime");
  }
  const sessionWebhookExpiresAt = new Date(expiresAtValue);
  if (Number.isNaN(sessionWebhookExpiresAt.getTime())) {
    throw new Error("钉钉机器人 sessionWebhookExpiredTime 无效");
  }
  const externalConversationId = required(robot.conversationId, "conversationId");
  const senderStaffId = required(robot.senderStaffId, "senderStaffId");
  const deliveryRoute = parseDingTalkDeliveryRoute({
    conversationType: required(robot.conversationType, "conversationType"),
    robotCode: required(robot.robotCode, "robotCode"),
    senderStaffId,
    ...(robot.conversationType === "2" ? { openConversationId: externalConversationId } : {}),
  });
  return {
    message: {
      connectorId,
      provider: "DINGTALK_STREAM",
      externalEventId: required(robot.msgId, "msgId"),
      externalMessageId: required(robot.msgId, "msgId"),
      externalConversationId,
      externalUserId: senderStaffId,
      externalUserName: typeof robot.senderNick === "string" ? robot.senderNick.trim() : "",
      text,
      occurredAt: occurredAt.toISOString(),
    },
    sessionWebhook: required(robot.sessionWebhook, "sessionWebhook"),
    sessionWebhookExpiresAt: sessionWebhookExpiresAt.toISOString(),
    deliveryRoute,
  };
}

export function validateDingTalkSessionWebhook(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("钉钉会话 Webhook 地址无效");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "oapi.dingtalk.com" ||
    url.pathname !== "/robot/sendBySession" ||
    !url.searchParams.get("session")
  ) {
    throw new Error("钉钉会话 Webhook 必须使用官方 sendBySession 地址并包含 session");
  }
  return url;
}

export class DingTalkSessionUnavailableError extends Error {
  constructor(message = "钉钉会话 Webhook 已失效") {
    super(message);
    this.name = "DingTalkSessionUnavailableError";
  }
}

export async function sendDingTalkSessionReply(
  webhook: string,
  text: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const response = await fetchWithTimeout(
    validateDingTalkSessionWebhook(webhook).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    },
    options.timeoutMs,
    options.fetchImpl,
  );
  if (response.status === 401) throw new DingTalkSessionUnavailableError();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (!response.ok) throw new Error(`外部平台返回 HTTP ${response.status}`);
    throw new Error("外部平台没有返回 JSON");
  }
  const parsed = (await response.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("外部平台没有返回 JSON 对象");
  }
  const body = parsed as Record<string, unknown>;
  if (body.errcode !== undefined && body.errcode !== 0) {
    const detail = String(body.errmsg ?? "");
    if (
      body.errcode === 400101 ||
      /(?:session|webhook).*(?:expired|invalid)|(?:过期|失效).*(?:session|webhook)/i.test(detail)
    ) {
      throw new DingTalkSessionUnavailableError();
    }
    throw new Error(`钉钉 Webhook 请求失败 (${String(body.errcode).slice(0, 40)})`);
  }
  if (!response.ok) throw new Error(`外部平台返回 HTTP ${response.status}`);
}

interface DingTalkAccessToken {
  value: string;
  expiresAt: number;
}

export interface DingTalkOpenApiOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DINGTALK_TOKEN_REFRESH_AHEAD_MS = 60_000;
const dingTalkAccessTokens = new Map<string, DingTalkAccessToken>();
const dingTalkAccessTokenRequests = new Map<string, Promise<string>>();

function dingTalkCredentials(config: ConnectorConfigPayload): {
  appKey: string;
  appSecret: string;
  cacheKey: string;
} {
  const appKey = required(config.clientId, "Client ID");
  const appSecret = required(config.clientSecret, "Client Secret");
  return {
    appKey,
    appSecret,
    cacheKey: createHash("sha256").update(`${appKey}\0${appSecret}`).digest("hex"),
  };
}

function safeDingTalkRequestError(operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const http = message.match(/HTTP\s+\d{3}/i)?.[0];
  if (http) return new Error(`${operation}失败：外部平台返回 ${http}`);
  if (message.includes("超时")) return new Error(`${operation}失败：请求超时`);
  if (message.includes("没有返回 JSON")) return new Error(`${operation}失败：响应格式无效`);
  return new Error(`${operation}失败`);
}

function dingTalkApiCode(body: Record<string, unknown>): string | null {
  const raw = body.code ?? body.errcode;
  if (raw === undefined || raw === null || raw === 0 || raw === "0" || raw === "ok") return null;
  const code = String(raw)
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 80);
  return code || "UNKNOWN";
}

function isDingTalkAuthenticationFailure(status: number, code: string | null): boolean {
  if (status === 401) return true;
  if (!code) return false;
  return (
    /(?:invalid|expired|illegal|missing).*(?:access)?token|(?:access)?token.*(?:invalid|expired|illegal|missing)/i.test(
      code,
    ) || /^(?:InvalidAuthentication|Unauthorized|40014|42001)$/i.test(code)
  );
}

function invalidateDingTalkAccessToken(
  config: ConnectorConfigPayload,
  rejectedToken: string,
): void {
  const { cacheKey } = dingTalkCredentials(config);
  const cached = dingTalkAccessTokens.get(cacheKey);
  // 并发请求可能已经刷新出新令牌；只能删除本次真正被拒绝的旧值。
  if (cached?.value === rejectedToken) dingTalkAccessTokens.delete(cacheKey);
}

async function requestDingTalkAccessToken(
  config: ConnectorConfigPayload,
  options: DingTalkOpenApiOptions,
): Promise<string> {
  const credentials = dingTalkCredentials(config);
  const now = options.now ?? Date.now;
  const cached = dingTalkAccessTokens.get(credentials.cacheKey);
  if (cached && cached.expiresAt > now() + DINGTALK_TOKEN_REFRESH_AHEAD_MS) {
    return cached.value;
  }
  const pending = dingTalkAccessTokenRequests.get(credentials.cacheKey);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetchWithTimeout(
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appKey: credentials.appKey, appSecret: credentials.appSecret }),
        },
        options.timeoutMs,
        options.fetchImpl,
      );
      const body = await readJsonResponse(response);
      const code = dingTalkApiCode(body);
      if (code) throw new Error(`钉钉 OpenAPI 令牌请求被拒绝 (${code})`);
      const accessToken = body.accessToken;
      const expireIn = body.expireIn;
      if (
        typeof accessToken !== "string" ||
        !accessToken.trim() ||
        typeof expireIn !== "number" ||
        !Number.isFinite(expireIn) ||
        expireIn <= 0
      ) {
        throw new Error("钉钉 OpenAPI 令牌响应无效");
      }
      dingTalkAccessTokens.set(credentials.cacheKey, {
        value: accessToken.trim(),
        expiresAt: now() + expireIn * 1_000,
      });
      return accessToken.trim();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("钉钉 OpenAPI")) throw error;
      throw safeDingTalkRequestError("钉钉 OpenAPI 获取访问令牌", error);
    }
  })();
  dingTalkAccessTokenRequests.set(credentials.cacheKey, request);
  try {
    return await request;
  } finally {
    dingTalkAccessTokenRequests.delete(credentials.cacheKey);
  }
}

function dingTalkMessageText(value: string): string {
  const content = value.trim();
  if (!content || content.length > 5_000) {
    throw new Error("钉钉主动投递文本长度必须为 1 到 5000 个字符");
  }
  return content;
}

function dingTalkProcessQueryKey(body: Record<string, unknown>): string | undefined {
  if (body.processQueryKey === undefined || body.processQueryKey === null) return undefined;
  if (
    typeof body.processQueryKey !== "string" ||
    !body.processQueryKey.trim() ||
    body.processQueryKey.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/.test(body.processQueryKey)
  ) {
    throw new Error("钉钉 OpenAPI processQueryKey 无效");
  }
  return body.processQueryKey.trim();
}

interface DingTalkOpenApiAttempt {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
  code: string | null;
}

async function sendDingTalkOpenApiAttempt(
  url: string,
  accessToken: string,
  requestBody: Record<string, unknown>,
  options: DingTalkOpenApiOptions,
): Promise<DingTalkOpenApiAttempt> {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify(requestBody),
    },
    options.timeoutMs,
    options.fetchImpl,
  );
  const contentType = response.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.toLowerCase().includes("application/json")) {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("外部平台没有返回 JSON 对象");
    }
    body = parsed as Record<string, unknown>;
  } else if (response.ok) {
    throw new Error("外部平台没有返回 JSON");
  }
  return {
    status: response.status,
    ok: response.ok,
    body,
    code: dingTalkApiCode(body),
  };
}

/** 使用企业机器人 OpenAPI 主动发送文本；返回 processQueryKey 供消息关联。 */
export async function sendDingTalkOpenApiText(
  config: ConnectorConfigPayload,
  routeValue: unknown,
  text: string,
  options: DingTalkOpenApiOptions = {},
): Promise<{ externalMessageId?: string }> {
  const route = parseDingTalkDeliveryRoute(routeValue);
  const content = dingTalkMessageText(text);
  const group = route.conversationType === "2";
  const url = group
    ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
    : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
  const requestBody = group
    ? {
        robotCode: route.robotCode,
        openConversationId: route.openConversationId!,
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content }),
      }
    : {
        robotCode: route.robotCode,
        userIds: [route.senderStaffId],
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content }),
      };
  try {
    let accessToken = await requestDingTalkAccessToken(config, options);
    let attempt = await sendDingTalkOpenApiAttempt(url, accessToken, requestBody, options);
    if (isDingTalkAuthenticationFailure(attempt.status, attempt.code)) {
      invalidateDingTalkAccessToken(config, accessToken);
      accessToken = await requestDingTalkAccessToken(config, options);
      // 认证失败只刷新并重试一次；第二次失败交给 outbox 的正常退避和运维处理。
      attempt = await sendDingTalkOpenApiAttempt(url, accessToken, requestBody, options);
    }
    // 第二次仍为认证失败时不继续递归重试，但也不能让下一次 job 复用已知坏令牌。
    if (isDingTalkAuthenticationFailure(attempt.status, attempt.code)) {
      invalidateDingTalkAccessToken(config, accessToken);
    }
    if (!attempt.ok) throw new Error(`外部平台返回 HTTP ${attempt.status}`);
    if (attempt.code) {
      throw new Error(`钉钉 OpenAPI 主动发送被拒绝 (${attempt.code})`);
    }
    const externalMessageId = dingTalkProcessQueryKey(attempt.body);
    return externalMessageId ? { externalMessageId } : {};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("钉钉 OpenAPI")) throw error;
    throw safeDingTalkRequestError("钉钉 OpenAPI 主动发送", error);
  }
}
