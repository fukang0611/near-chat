import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { ConnectorConfigPayload, ConnectorInboundTextMessage } from "./connector-provider.js";
import { fetchWithTimeout, readJsonResponse } from "./connector-http.js";

const WECOM_PADDING_BLOCK_SIZE = 32;
const MAX_CALLBACK_CLOCK_SKEW_SECONDS = 300;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
});

function callbackConfig(config: ConnectorConfigPayload) {
  if (
    !config.callbackToken ||
    !config.encodingAesKey ||
    !config.corpId ||
    !config.agentId ||
    !config.clientSecret
  ) {
    throw new Error("企业微信回调配置不完整");
  }
  return {
    token: config.callbackToken,
    encodingAesKey: config.encodingAesKey,
    corpId: config.corpId,
    agentId: config.agentId,
    clientSecret: config.clientSecret,
  };
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("企业微信 EncodingAESKey 解码后必须为 32 字节");
  return key;
}

function pkcs7Pad(value: Buffer): Buffer {
  const padding = WECOM_PADDING_BLOCK_SIZE - (value.length % WECOM_PADDING_BLOCK_SIZE);
  return Buffer.concat([value, Buffer.alloc(padding, padding)]);
}

function pkcs7Unpad(value: Buffer): Buffer {
  if (!value.length) throw new Error("企业微信回调密文为空");
  const padding = value[value.length - 1]!;
  if (padding < 1 || padding > WECOM_PADDING_BLOCK_SIZE || padding > value.length) {
    throw new Error("企业微信回调填充无效");
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) throw new Error("企业微信回调填充无效");
  }
  return value.subarray(0, value.length - padding);
}

export function weComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

export function verifyWeComSignature(input: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
  signature: string;
}): boolean {
  const expected = Buffer.from(
    weComSignature(input.token, input.timestamp, input.nonce, input.encrypted),
    "utf8",
  );
  const actual = Buffer.from(input.signature.toLowerCase(), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateWeComCallbackTimestamp(
  timestamp: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  const parsed = Number.parseInt(timestamp, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    Math.abs(nowSeconds - parsed) > MAX_CALLBACK_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("企业微信回调时间戳已过期");
  }
}

export function encryptWeComPayload(
  plaintext: string,
  encodingAesKey: string,
  receiveId: string,
  randomPrefix = randomBytes(16),
): string {
  if (randomPrefix.length !== 16) throw new Error("企业微信加密随机前缀必须为 16 字节");
  const body = Buffer.from(plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const packed = pkcs7Pad(
    Buffer.concat([randomPrefix, length, body, Buffer.from(receiveId, "utf8")]),
  );
  const key = aesKey(encodingAesKey);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(packed), cipher.final()]).toString("base64");
}

export function decryptWeComPayload(
  encrypted: string,
  encodingAesKey: string,
  expectedReceiveId: string,
): string {
  const key = aesKey(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const packed = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]),
  );
  if (packed.length < 20) throw new Error("企业微信回调明文长度无效");
  const messageLength = packed.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > packed.length) throw new Error("企业微信回调消息长度无效");
  const receiveId = packed.subarray(messageEnd).toString("utf8");
  const expected = Buffer.from(expectedReceiveId, "utf8");
  const actual = Buffer.from(receiveId, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("企业微信回调 Corp ID 不匹配");
  }
  return packed.subarray(20, messageEnd).toString("utf8");
}

function xmlRoot(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("企业微信回调 XML 不允许 DTD 或实体声明");
  const parsed = xmlParser.parse(xml) as { xml?: unknown };
  if (!parsed.xml || typeof parsed.xml !== "object" || Array.isArray(parsed.xml)) {
    throw new Error("企业微信回调 XML 缺少根节点");
  }
  return parsed.xml as Record<string, unknown>;
}

function xmlString(root: Record<string, unknown>, field: string, required = true): string {
  const value = root[field];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (required) throw new Error(`企业微信回调 XML 缺少 ${field}`);
  return "";
}

export function encryptedWeComEnvelope(xml: string): string {
  return xmlString(xmlRoot(xml), "Encrypt");
}

export function verifyAndDecryptWeComCallback(input: {
  config: ConnectorConfigPayload;
  signature: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
  nowSeconds?: number;
}): string {
  const config = callbackConfig(input.config);
  validateWeComCallbackTimestamp(input.timestamp, input.nowSeconds);
  if (
    !verifyWeComSignature({
      token: config.token,
      timestamp: input.timestamp,
      nonce: input.nonce,
      encrypted: input.encrypted,
      signature: input.signature,
    })
  ) {
    throw new Error("企业微信回调签名无效");
  }
  return decryptWeComPayload(input.encrypted, config.encodingAesKey, config.corpId);
}

export function parseWeComTextMessage(
  connectorId: string,
  plaintextXml: string,
  expectedAgentId: string,
): ConnectorInboundTextMessage | null {
  const root = xmlRoot(plaintextXml);
  if (xmlString(root, "MsgType").toLowerCase() !== "text") return null;
  const agentId = xmlString(root, "AgentID", false);
  if (agentId && agentId !== expectedAgentId) throw new Error("企业微信回调 Agent ID 不匹配");
  const externalUserId = xmlString(root, "FromUserName");
  const externalMessageId = xmlString(root, "MsgId");
  const createdSeconds = Number.parseInt(xmlString(root, "CreateTime"), 10);
  return {
    connectorId,
    provider: "WECOM_CALLBACK",
    externalEventId: externalMessageId,
    externalMessageId,
    externalConversationId: xmlString(root, "ChatId", false) || externalUserId,
    externalUserId,
    externalUserName: externalUserId,
    text: xmlString(root, "Content"),
    occurredAt: new Date(
      Number.isSafeInteger(createdSeconds) ? createdSeconds * 1_000 : Date.now(),
    ).toISOString(),
  };
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const accessTokens = new Map<string, CachedToken>();
const pendingAccessTokens = new Map<string, Promise<string>>();

function tokenCacheKey(config: ReturnType<typeof callbackConfig>): string {
  return createHash("sha256").update(`${config.corpId}\0${config.clientSecret}`).digest("hex");
}

export function validateWeComUserId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.@-]{1,200}$/.test(normalized) || normalized.toLowerCase() === "@all") {
    throw new Error("企业微信投递目标必须是单一成员账号，不能使用广播目标");
  }
  return normalized;
}

async function weComAccessToken(
  config: ReturnType<typeof callbackConfig>,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const cacheKey = tokenCacheKey(config);
  const cached = accessTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const pending = pendingAccessTokens.get(cacheKey);
  if (pending) return pending;
  const loading = (async () => {
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
    url.searchParams.set("corpid", config.corpId);
    url.searchParams.set("corpsecret", config.clientSecret);
    const body = await readJsonResponse(
      await fetchWithTimeout(
        url.toString(),
        { method: "GET" },
        options.timeoutMs,
        options.fetchImpl,
      ),
    );
    if (body.errcode !== 0 || typeof body.access_token !== "string") {
      throw new Error(String(body.errmsg ?? `企业微信令牌错误 ${body.errcode}`));
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 7_200;
    accessTokens.set(cacheKey, {
      value: body.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    });
    return body.access_token;
  })();
  pendingAccessTokens.set(cacheKey, loading);
  try {
    return await loading;
  } finally {
    if (pendingAccessTokens.get(cacheKey) === loading) pendingAccessTokens.delete(cacheKey);
  }
}

function invalidateWeComAccessToken(
  config: ReturnType<typeof callbackConfig>,
  rejectedToken: string,
): void {
  const cacheKey = tokenCacheKey(config);
  if (accessTokens.get(cacheKey)?.value === rejectedToken) accessTokens.delete(cacheKey);
}

async function readWeComSendResponse(
  response: Response,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const contentType = response.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.toLowerCase().includes("application/json")) {
    body = (await response.json()) as Record<string, unknown>;
  } else if (response.ok) {
    throw new Error("外部平台没有返回 JSON");
  }
  // 401 要交给上层执行一次受控刷新；其他 HTTP 错误保持原来的失败语义。
  if (!response.ok && response.status !== 401) {
    throw new Error(`外部平台返回 HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

export async function sendWeComAppText(
  configPayload: ConnectorConfigPayload,
  externalUserId: string,
  text: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ externalMessageId?: string }> {
  const config = callbackConfig(configPayload);
  const userId = validateWeComUserId(externalUserId);
  const send = async (token: string) => {
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/message/send");
    url.searchParams.set("access_token", token);
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: userId,
          msgtype: "text",
          agentid: config.agentId,
          text: { content: text },
          safe: 0,
          // 企业微信应用消息支持内容级重复检查，可缩小“平台已收但本地状态未提交”窗口。
          enable_duplicate_check: 1,
          duplicate_check_interval: 1_800,
        }),
      },
      options.timeoutMs,
      options.fetchImpl,
    );
    return readWeComSendResponse(response);
  };
  let token = await weComAccessToken(config, options);
  let result = await send(token);
  const authenticationFailed = (status: number, body: Record<string, unknown>) =>
    status === 401 || body.errcode === 40014 || body.errcode === 42001;
  if (authenticationFailed(result.status, result.body)) {
    invalidateWeComAccessToken(config, token);
    token = await weComAccessToken(config, options);
    result = await send(token);
    if (authenticationFailed(result.status, result.body)) {
      invalidateWeComAccessToken(config, token);
    }
  }
  const body = result.body;
  if (result.status !== 200 || body.errcode !== 0)
    throw new Error(String(body.errmsg ?? `企业微信消息错误 ${body.errcode}`));
  return typeof body.msgid === "string" && body.msgid.trim()
    ? { externalMessageId: body.msgid.trim() }
    : {};
}
