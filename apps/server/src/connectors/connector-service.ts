import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { decryptAiSecret, encryptAiSecret } from "../ai/ai-settings-service.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import {
  parseDingTalkDeliveryRoute,
  tryParseDingTalkDeliveryRoute,
  validateDingTalkSessionWebhook,
  type DingTalkDeliveryRoute,
} from "./dingtalk-connector.js";
import { validateWeComUserId } from "./wecom-callback.js";
import {
  CONNECTOR_PROVIDERS,
  type ConnectorBinding,
  type ConnectorConfigPatch,
  type ConnectorConfigPayload,
  type ConnectorDeliveryKind,
  type ConnectorIdentity,
  type ConnectorInboundTextMessage,
  type ConnectorProvider,
} from "./connector-provider.js";

interface ConfigRow {
  id: string;
  provider: ConnectorProvider;
  name: string;
  enabled: boolean;
  config_encrypted: string;
  revision: number;
  last_error: string | null;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectorJobRow {
  id: string;
  connector_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  idempotency_key: string;
}

export interface ConnectorEventRow {
  id: string;
  connector_id: string;
  provider: ConnectorProvider;
  external_event_id: string;
  external_conversation_id: string;
  external_user_id: string;
  event_kind: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  attempts: number;
}

export interface ConnectorEventAuthorizationSnapshot {
  bindingId: string;
  bindingOwnerId: string;
  bindingAssistantId: string;
  bindingNearChatConversationId: string | null;
  identityId: string;
  identityNearChatUserId: string;
}

interface ConnectorEventAuthorizationRow {
  binding_id: string;
  binding_owner_id: string;
  binding_assistant_id: string;
  binding_near_chat_conversation_id: string | null;
  identity_id: string;
  identity_near_chat_user_id: string;
}

const CONNECTOR_EVENT_AUTHORIZATION_SQL = `
  SELECT binding.id AS binding_id,binding.owner_id AS binding_owner_id,
         binding.assistant_id AS binding_assistant_id,
         binding.near_chat_conversation_id AS binding_near_chat_conversation_id,
         identity.id AS identity_id,identity.near_chat_user_id AS identity_near_chat_user_id
    FROM connector_configs config
    JOIN connector_bindings binding
      ON binding.connector_id=config.id AND binding.external_conversation_id=$2
     AND binding.enabled=TRUE
    JOIN users owner ON owner.id=binding.owner_id AND owner.enabled=TRUE
    JOIN ai_assistants assistant
      ON assistant.id=binding.assistant_id AND assistant.owner_id=binding.owner_id
     AND assistant.deleted_at IS NULL
    JOIN connector_identities identity
      ON identity.connector_id=config.id AND identity.external_user_id=$3
     AND identity.near_chat_user_id=binding.owner_id
    JOIN users mapped_user ON mapped_user.id=identity.near_chat_user_id
     AND mapped_user.enabled=TRUE
   WHERE config.id=$1 AND config.enabled=TRUE`;

function toConnectorEventAuthorization(
  row: ConnectorEventAuthorizationRow | undefined,
): ConnectorEventAuthorizationSnapshot | null {
  return row
    ? {
        bindingId: row.binding_id,
        bindingOwnerId: row.binding_owner_id,
        bindingAssistantId: row.binding_assistant_id,
        bindingNearChatConversationId: row.binding_near_chat_conversation_id,
        identityId: row.identity_id,
        identityNearChatUserId: row.identity_near_chat_user_id,
      }
    : null;
}

function parseStoredEventAuthorization(value: unknown): ConnectorEventAuthorizationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<ConnectorEventAuthorizationSnapshot>;
  if (
    typeof snapshot.bindingId !== "string" ||
    typeof snapshot.bindingOwnerId !== "string" ||
    typeof snapshot.bindingAssistantId !== "string" ||
    (snapshot.bindingNearChatConversationId !== null &&
      typeof snapshot.bindingNearChatConversationId !== "string") ||
    typeof snapshot.identityId !== "string" ||
    typeof snapshot.identityNearChatUserId !== "string"
  ) {
    return null;
  }
  return snapshot as ConnectorEventAuthorizationSnapshot;
}

function sameStoredEventAuthorization(
  expected: ConnectorEventAuthorizationSnapshot,
  current: ConnectorEventAuthorizationSnapshot | null,
): boolean {
  return Boolean(
    current &&
    current.bindingId === expected.bindingId &&
    current.bindingOwnerId === expected.bindingOwnerId &&
    current.bindingAssistantId === expected.bindingAssistantId &&
    current.bindingNearChatConversationId === expected.bindingNearChatConversationId &&
    current.identityId === expected.identityId &&
    current.identityNearChatUserId === expected.identityNearChatUserId,
  );
}

interface IdentityRow {
  id: string;
  connector_id: string;
  external_user_id: string;
  near_chat_user_id: string | null;
  display_name: string;
  metadata: Record<string, unknown>;
}

interface BindingRow {
  id: string;
  connector_id: string;
  owner_id: string;
  external_conversation_id: string;
  near_chat_conversation_id: string | null;
  assistant_id: string | null;
  delivery_kinds: ConnectorDeliveryKind[];
  delivery_target_encrypted: string | null;
  delivery_target_expires_at: Date | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  provider?: ConnectorProvider;
}

const CONFIG_COLUMNS = `id,provider,name,enabled,config_encrypted,revision,last_error,started_at,created_at,updated_at`;
const MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_EVENT_LEASE_SECONDS = 120;
const CONNECTOR_ERROR_LIMIT = 500;
const DINGTALK_ROUTE_METADATA_KEYS = [
  "conversationType",
  "robotCode",
  "senderStaffId",
  "openConversationId",
] as const;

function dingTalkRouteMetadata(route: DingTalkDeliveryRoute): Record<string, unknown> {
  return {
    conversationType: route.conversationType,
    robotCode: route.robotCode,
    senderStaffId: route.senderStaffId,
    ...(route.openConversationId ? { openConversationId: route.openConversationId } : {}),
  };
}

function bindingMetadataForSave(
  provider: ConnectorProvider,
  current: Record<string, unknown> | undefined,
  submitted: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const metadata = { ...(submitted ?? current ?? {}) };
  if (provider !== "DINGTALK_STREAM") return metadata;
  // 钉钉主动投递路由只能由已验真的 Stream CALLBACK 刷新，管理员表单不能伪造或清空。
  for (const key of DINGTALK_ROUTE_METADATA_KEYS) delete metadata[key];
  for (const key of DINGTALK_ROUTE_METADATA_KEYS) {
    if (current?.[key] !== undefined) metadata[key] = current[key];
  }
  return metadata;
}

function publicBindingMetadata(
  provider: ConnectorProvider | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (provider !== "DINGTALK_STREAM") return metadata;
  const visible = { ...metadata };
  // 主动投递路由只能以 capability 布尔值公开，不能暴露或允许管理端回填平台标识。
  for (const key of DINGTALK_ROUTE_METADATA_KEYS) delete visible[key];
  return visible;
}

/** 连接器错误可能来自第三方 SDK/HTTP 栈；写库、日志和 API 返回前统一移除凭据。 */
export function redactConnectorErrorMessage(value: unknown, fallback = "连接器操作失败"): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  const sensitiveName =
    "access[_-]?token|refresh[_-]?token|callback[_-]?token|token|api[_-]?key|encoding[_-]?aes[_-]?key|client[_-]?secret|app[_-]?secret|corp[_-]?secret|secret|webhook(?:[_-]?url)?|session|key";
  return raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?\bauthorization\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(
        `(["']?\\b(?:${sensitiveName})\\b["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^,\\s;&}]+)`,
        "gi",
      ),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(\\b(?:${sensitiveName})\\b\\s+)[A-Za-z0-9._~+/=-]{6,}`, "gi"),
      "$1[REDACTED]",
    )
    .replace(/([?&][A-Za-z0-9_.~-]{1,100}=)[^&\s"'<>]*/g, "$1[REDACTED]")
    .slice(0, CONNECTOR_ERROR_LIMIT);
}

function parseConfig(row: ConfigRow): ConnectorConfigPayload {
  try {
    return JSON.parse(decryptAiSecret(row.config_encrypted)) as ConnectorConfigPayload;
  } catch {
    throw new ApiError(503, `连接器“${row.name}”的配置无法解密，请由管理员重新保存`);
  }
}

export function connectorCallbackUrl(
  provider: ConnectorProvider,
  connectorId: string,
  publicBaseUrl = config.publicBaseUrl,
): string | null {
  return provider === "WECOM_CALLBACK" && publicBaseUrl
    ? `${publicBaseUrl}/api/connectors/wecom/${connectorId}/callback`
    : null;
}

function publicConfig(row: ConfigRow) {
  const config = parseConfig(row);
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled,
    revision: row.revision,
    callbackUrl: connectorCallbackUrl(row.provider, row.id),
    hasClientId: Boolean(config.clientId),
    hasClientSecret: Boolean(config.clientSecret),
    hasWebhookUrl: Boolean(config.webhookUrl),
    hasCallbackToken: Boolean(config.callbackToken),
    hasEncodingAesKey: Boolean(config.encodingAesKey),
    hasCorpId: Boolean(config.corpId),
    hasAgentId: Boolean(config.agentId),
    runtime: {
      running: Boolean(row.started_at) && !row.last_error,
      startedAt: row.started_at?.toISOString() ?? null,
      error: row.last_error ? redactConnectorErrorMessage(row.last_error) : null,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ApiError(400, message);
  return normalized;
}

function futureTimestamp(value: string | undefined | null, message: string): Date {
  const parsed = value ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    throw new ApiError(400, message);
  }
  return parsed;
}

/** 写库前完成协议必填项与出站主机约束，避免无效配置和任意 HTTPS SSRF。 */
export function validateConnectorConfig(
  provider: ConnectorProvider,
  config: ConnectorConfigPayload,
): ConnectorConfigPayload {
  if (provider === "DINGTALK_STREAM") {
    return {
      clientId: required(config.clientId, "钉钉 Stream 必须填写 Client ID"),
      clientSecret: required(config.clientSecret, "钉钉 Stream 必须填写 Client Secret"),
    };
  }
  if (provider === "WECOM_WEBHOOK") {
    const webhookUrl = required(config.webhookUrl, "企业微信机器人必须填写 Webhook 地址");
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new ApiError(400, "企业微信 Webhook 地址格式不正确");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "qyapi.weixin.qq.com" ||
      url.pathname !== "/cgi-bin/webhook/send" ||
      !url.searchParams.get("key")
    ) {
      throw new ApiError(400, "企业微信 Webhook 必须使用官方机器人发送地址并包含 key");
    }
    return { webhookUrl: url.toString() };
  }
  const callbackToken = required(config.callbackToken, "企业微信回调必须填写 Token");
  const encodingAesKey = required(config.encodingAesKey, "企业微信回调必须填写 EncodingAESKey");
  const corpId = required(config.corpId, "企业微信回调必须填写 Corp ID");
  const agentId = required(config.agentId, "企业微信回调必须填写 Agent ID");
  const clientSecret = required(config.clientSecret, "企业微信回调必须填写应用 Secret");
  if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) {
    throw new ApiError(400, "企业微信 EncodingAESKey 必须是 43 位 Base64 字符");
  }
  return { callbackToken, encodingAesKey, corpId, agentId, clientSecret };
}

function mergeConfig(
  current: ConnectorConfigPayload,
  patch: ConnectorConfigPatch | undefined,
): ConnectorConfigPayload {
  if (!patch) return current;
  const merged = { ...current };
  for (const key of Object.keys(patch) as Array<keyof ConnectorConfigPayload>) {
    const value = patch[key];
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export async function listConnectorConfigs() {
  return (
    await query<ConfigRow>(`SELECT ${CONFIG_COLUMNS} FROM connector_configs ORDER BY provider,name`)
  ).rows.map(publicConfig);
}

export async function listEnabledDingTalkConnectorIds() {
  return (
    await query<{ id: string }>(
      `SELECT id FROM connector_configs WHERE provider='DINGTALK_STREAM' AND enabled=TRUE`,
    )
  ).rows.map((row) => row.id);
}

export async function createConnectorConfig(
  actorId: string,
  input: {
    provider: ConnectorProvider;
    name: string;
    enabled: boolean;
    config: ConnectorConfigPayload;
  },
) {
  const normalized = validateConnectorConfig(input.provider, input.config);
  const row = await query<ConfigRow>(
    `INSERT INTO connector_configs (id,provider,name,enabled,config_encrypted,created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${CONFIG_COLUMNS}`,
    [
      randomUUID(),
      input.provider,
      input.name,
      input.enabled,
      encryptAiSecret(JSON.stringify(normalized)),
      actorId,
    ],
  );
  return publicConfig(row.rows[0]!);
}

export async function updateConnectorConfig(
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
    revision: number;
    config?: ConnectorConfigPatch;
  },
) {
  return transaction(async (client) => {
    const selected = await client.query<ConfigRow>(
      `SELECT ${CONFIG_COLUMNS} FROM connector_configs WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const current = selected.rows[0];
    if (!current) throw new ApiError(404, "连接器不存在");
    if (current.revision !== input.revision)
      throw new ApiError(409, "连接器配置已更新，请刷新后重试");
    const config = validateConnectorConfig(
      current.provider,
      mergeConfig(parseConfig(current), input.config),
    );
    const updated = await client.query<ConfigRow>(
      `UPDATE connector_configs
          SET name=$2,enabled=$3,config_encrypted=$4,revision=revision+1,
              last_error=NULL,started_at=NULL,updated_at=NOW()
        WHERE id=$1 RETURNING ${CONFIG_COLUMNS}`,
      [
        id,
        input.name ?? current.name,
        input.enabled ?? current.enabled,
        encryptAiSecret(JSON.stringify(config)),
      ],
    );
    if (current.enabled && input.enabled === false) {
      await client.query(
        `UPDATE connector_events
            SET status='CANCELLED',lease_expires_at=NULL,
                error_message=COALESCE(error_message,'连接器已停用')
          WHERE connector_id=$1 AND status IN ('RECEIVED','FAILED')`,
        [id],
      );
      await client.query(
        `UPDATE connector_delivery_jobs
            SET status='CANCELLED',lease_expires_at=NULL,
                error_message=COALESCE(error_message,'连接器已停用'),updated_at=NOW()
          WHERE connector_id=$1 AND status IN ('QUEUED','FAILED')`,
        [id],
      );
    }
    return publicConfig(updated.rows[0]!);
  });
}

export async function deleteConnectorConfig(id: string): Promise<void> {
  const result = await query(`DELETE FROM connector_configs WHERE id=$1`, [id]);
  if (!result.rowCount) throw new ApiError(404, "连接器不存在");
}

export async function loadConnectorConfig(id: string, requireEnabled = true) {
  const result = await query<ConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM connector_configs WHERE id=$1`,
    [id],
  );
  const config = result.rows[0];
  if (!config || (requireEnabled && !config.enabled)) {
    throw new ApiError(404, "连接器不存在或未启用");
  }
  return { config, payload: parseConfig(config) };
}

export async function setConnectorRuntimeState(
  id: string,
  state: { running: boolean; error?: unknown },
): Promise<void> {
  const error =
    state.error === undefined ? null : redactConnectorErrorMessage(state.error, "连接器启动失败");
  await query(
    `UPDATE connector_configs
        SET started_at=CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
            last_error=$3,updated_at=NOW()
      WHERE id=$1`,
    [id, state.running, error],
  );
}

export async function queueConnectorDelivery(input: {
  connectorId: string;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  deliveryTarget?: string;
  deliveryTargetExpiresAt?: string;
}): Promise<{ id: string; created: boolean }> {
  return transaction(async (client) => queueConnectorDeliveryWithClient(client, input, true));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function deliveryFingerprint(kind: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ kind, payload })).digest("hex");
}

async function queueConnectorDeliveryWithClient(
  client: PoolClient,
  input: {
    connectorId: string;
    kind: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    deliveryTarget?: string;
    deliveryTargetExpiresAt?: string;
  },
  requireEnabled: boolean,
): Promise<{ id: string; created: boolean }> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ApiError(400, "投递幂等键长度必须为 1 到 200 个字符");
  }
  if (requireEnabled) {
    const enabled = await client.query<{ id: string; provider: ConnectorProvider }>(
      `SELECT id,provider FROM connector_configs
        WHERE id=$1 AND enabled=TRUE
        FOR SHARE`,
      [input.connectorId],
    );
    const connector = enabled.rows[0];
    if (!connector) throw new ApiError(404, "连接器不存在或未启用");
    const target = input.deliveryTarget?.trim();
    if (connector.provider !== "WECOM_WEBHOOK" && !target) {
      throw new ApiError(400, "该连接器的手工投递必须填写外部投递目标");
    }
    if (target) {
      if (connector.provider === "DINGTALK_STREAM") {
        try {
          validateDingTalkSessionWebhook(target);
        } catch {
          throw new ApiError(400, "钉钉投递目标必须是有效的会话 Webhook");
        }
        futureTimestamp(
          input.deliveryTargetExpiresAt,
          "钉钉会话 Webhook 必须填写尚未过期的失效时间",
        );
      } else if (connector.provider === "WECOM_WEBHOOK") {
        throw new ApiError(400, "企业微信群机器人投递目标已由连接器配置确定");
      } else {
        try {
          validateWeComUserId(target);
        } catch {
          throw new ApiError(400, "企业微信投递目标必须是单一成员账号，不能使用广播目标");
        }
      }
    }
  }
  const sanitizedPayload = { ...input.payload };
  delete sanitizedPayload._idempotencyFingerprint;
  if (requireEnabled) {
    // 公共手工投递不能伪造只应由绑定/CALLBACK 产生的可信内部路由。
    for (const key of [
      "dingTalkRoute",
      "bindingId",
      "bindingOwnerId",
      "encryptedDeliveryTarget",
      "deliveryTargetExpiresAt",
    ]) {
      delete sanitizedPayload[key];
    }
  }
  const body = { ...sanitizedPayload };
  if (input.deliveryTarget) {
    body.encryptedDeliveryTarget = encryptAiSecret(input.deliveryTarget.trim());
  }
  if (input.deliveryTargetExpiresAt) {
    body.deliveryTargetExpiresAt = new Date(input.deliveryTargetExpiresAt).toISOString();
  }
  const fingerprintPayload: Record<string, unknown> = {
    ...sanitizedPayload,
    ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget.trim() } : {}),
    ...(input.deliveryTargetExpiresAt
      ? { deliveryTargetExpiresAt: new Date(input.deliveryTargetExpiresAt).toISOString() }
      : {}),
  };
  const fingerprint = deliveryFingerprint(input.kind, fingerprintPayload);
  body._idempotencyFingerprint = fingerprint;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO connector_delivery_jobs
         (id,connector_id,kind,payload,idempotency_key)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (connector_id,idempotency_key) DO NOTHING RETURNING id`,
    [randomUUID(), input.connectorId, input.kind, body, idempotencyKey],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await client.query<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id,kind,payload FROM connector_delivery_jobs
      WHERE connector_id=$1 AND idempotency_key=$2`,
    [input.connectorId, idempotencyKey],
  );
  const stored = existing.rows[0]!;
  if (stored.kind !== input.kind || stored.payload._idempotencyFingerprint !== fingerprint) {
    throw new ApiError(409, "投递幂等键已被不同内容使用");
  }
  return { id: stored.id, created: false };
}

/** 供任务、提醒、摘要领域调用；稳定来源 ID 会展开为每个绑定独立的幂等投递。 */
export async function queueBoundConnectorDeliveries(input: {
  ownerId: string;
  kind: ConnectorDeliveryKind;
  sourceId: string;
  payload: Record<string, unknown>;
}): Promise<Array<{ connectorId: string; jobId: string; created: boolean }>> {
  return transaction((client) => queueBoundConnectorDeliveriesWithClient(client, input));
}

export async function queueBoundConnectorDeliveriesWithClient(
  client: PoolClient,
  input: {
    ownerId: string;
    kind: ConnectorDeliveryKind;
    sourceId: string;
    payload: Record<string, unknown>;
  },
): Promise<Array<{ connectorId: string; jobId: string; created: boolean }>> {
  const bindings = await client.query<{
    id: string;
    connector_id: string;
    provider: ConnectorProvider;
    external_conversation_id: string;
    delivery_target_encrypted: string | null;
    delivery_target_expires_at: Date | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT binding.id,binding.connector_id,config.provider,binding.external_conversation_id,
            binding.delivery_target_encrypted,binding.delivery_target_expires_at,binding.metadata
       FROM connector_bindings binding
       JOIN connector_configs config ON config.id=binding.connector_id
       JOIN users owner ON owner.id=binding.owner_id AND owner.enabled=TRUE
      WHERE binding.owner_id=$1 AND binding.enabled=TRUE AND config.enabled=TRUE
        AND $2=ANY(binding.delivery_kinds)
      FOR SHARE OF binding,config`,
    [input.ownerId, input.kind],
  );
  const result: Array<{ connectorId: string; jobId: string; created: boolean }> = [];
  for (const binding of bindings.rows) {
    const queued = await queueConnectorDeliveryWithClient(
      client,
      {
        connectorId: binding.connector_id,
        kind: input.kind,
        idempotencyKey: `${input.kind}:${input.sourceId}:${binding.id}`,
        payload: {
          ...input.payload,
          bindingId: binding.id,
          bindingOwnerId: input.ownerId,
          externalConversationId: binding.external_conversation_id,
          encryptedDeliveryTarget: binding.delivery_target_encrypted,
          deliveryTargetExpiresAt: binding.delivery_target_expires_at?.toISOString() ?? null,
          ...(binding.provider === "DINGTALK_STREAM"
            ? { dingTalkRoute: tryParseDingTalkDeliveryRoute(binding.metadata) }
            : {}),
        },
      },
      false,
    );
    result.push({ connectorId: binding.connector_id, jobId: queued.id, created: queued.created });
  }
  return result;
}

export async function nextConnectorJobs(
  limit = 20,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<ConnectorJobRow[]> {
  return transaction(async (client) => {
    await client.query(
      `UPDATE connector_delivery_jobs
          SET status=CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'QUEUED' END,
              lease_expires_at=NULL,
              next_attempt_at=CASE WHEN attempts >= $1 THEN next_attempt_at ELSE NOW() END,
              error_message=CASE WHEN attempts >= $1 THEN '投递进程在完成前退出' ELSE error_message END,
              updated_at=NOW()
        WHERE status='RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())`,
      [MAX_ATTEMPTS],
    );
    const jobs = await client.query<ConnectorJobRow>(
      `WITH candidates AS (
         SELECT job.id
           FROM connector_delivery_jobs job
           JOIN connector_configs config ON config.id=job.connector_id
          WHERE job.status='QUEUED' AND job.next_attempt_at<=NOW() AND job.attempts<$2
            AND config.enabled=TRUE
            AND (
              NOT (job.payload ? 'bindingId') OR EXISTS (
                SELECT 1 FROM connector_bindings binding
                JOIN users owner ON owner.id=binding.owner_id AND owner.enabled=TRUE
                 WHERE binding.id::text=job.payload->>'bindingId'
                   AND binding.connector_id=job.connector_id
                   AND binding.enabled=TRUE
                   AND job.kind=ANY(binding.delivery_kinds)
                   AND binding.owner_id::text=job.payload->>'bindingOwnerId'
              )
            )
          ORDER BY job.created_at FOR UPDATE OF job SKIP LOCKED LIMIT $1
       )
       UPDATE connector_delivery_jobs job
          SET status='RUNNING',attempts=job.attempts+1,
              lease_expires_at=NOW()+make_interval(secs => $3),updated_at=NOW()
         FROM candidates WHERE job.id=candidates.id
       RETURNING job.id,job.connector_id,job.kind,job.payload,job.attempts,job.idempotency_key`,
      [limit, MAX_ATTEMPTS, leaseSeconds],
    );
    return jobs.rows;
  });
}

export async function finishConnectorJob(id: string, error?: unknown): Promise<void> {
  if (!error) {
    await query(
      `UPDATE connector_delivery_jobs
          SET status='SUCCEEDED',lease_expires_at=NULL,error_message=NULL,updated_at=NOW()
        WHERE id=$1 AND status='RUNNING'`,
      [id],
    );
    return;
  }
  const message = redactConnectorErrorMessage(error, "连接器投递失败");
  await query(
    `UPDATE connector_delivery_jobs
        SET status=CASE WHEN attempts>=$2 THEN 'FAILED' ELSE 'QUEUED' END,
            lease_expires_at=NULL,
            next_attempt_at=NOW()+make_interval(secs => LEAST(attempts*10,300)),
            error_message=$3,updated_at=NOW()
      WHERE id=$1 AND status='RUNNING'`,
    [id, MAX_ATTEMPTS, message],
  );
}

export async function recordConnectorEvent(input: {
  connectorId: string;
  message: ConnectorInboundTextMessage;
  encryptedReplyTarget?: string;
  replyTargetExpiresAt?: string;
  dingTalkRoute?: DingTalkDeliveryRoute;
}): Promise<{ id: string | null; created: boolean; status: string }> {
  return transaction((client) => recordConnectorEventWithClient(client, input));
}

export async function recordConnectorEventWithClient(
  client: PoolClient,
  input: {
    connectorId: string;
    message: ConnectorInboundTextMessage;
    encryptedReplyTarget?: string;
    replyTargetExpiresAt?: string;
    dingTalkRoute?: DingTalkDeliveryRoute;
  },
): Promise<{ id: string | null; created: boolean; status: string }> {
  // 与停用事务共享锁到 INSERT 提交：停用要么等待并随后取消该事件，
  // 要么先完成，此处正常 ACK 但不再持久化，避免停用后的“晚插”复活。
  const connector = await client.query<{ provider: ConnectorProvider; enabled: boolean }>(
    `SELECT provider,enabled FROM connector_configs WHERE id=$1 FOR SHARE`,
    [input.connectorId],
  );
  const current = connector.rows[0];
  if (!current || current.provider !== input.message.provider) {
    throw new ApiError(404, "连接器不存在或消息来源不匹配");
  }
  if (!current.enabled) return { id: null, created: false, status: "DROPPED" };
  const dingTalkRoute =
    input.message.provider === "DINGTALK_STREAM" && input.dingTalkRoute
      ? parseDingTalkDeliveryRoute(input.dingTalkRoute)
      : undefined;
  const payload = {
    message: input.message,
    encryptedReplyTarget: input.encryptedReplyTarget,
    replyTargetExpiresAt: input.replyTargetExpiresAt,
    dingTalkRoute,
  };
  const inserted = await client.query<{ id: string; status: string }>(
    `INSERT INTO connector_events
         (id,connector_id,external_event_id,event_kind,external_conversation_id,
          external_user_id,payload,status)
       VALUES ($1,$2,$3,'TEXT',$4,$5,$6,'RECEIVED')
       ON CONFLICT (connector_id,external_event_id) DO NOTHING RETURNING id,status`,
    [
      randomUUID(),
      input.connectorId,
      input.message.externalEventId,
      input.message.externalConversationId,
      input.message.externalUserId,
      payload,
    ],
  );
  if (input.message.provider === "DINGTALK_STREAM") {
    const expiresAt = input.replyTargetExpiresAt
      ? new Date(input.replyTargetExpiresAt)
      : new Date(Number.NaN);
    const refreshSession = Boolean(
      input.encryptedReplyTarget &&
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt.getTime() > Date.now(),
    );
    if (dingTalkRoute || refreshSession) {
      const bindings = await client.query<{ id: string }>(
        `UPDATE connector_bindings
              SET metadata=metadata || $3::jsonb,
                  delivery_target_encrypted=CASE WHEN $4::boolean THEN $5::text
                                                 ELSE delivery_target_encrypted END,
                  delivery_target_expires_at=CASE WHEN $4::boolean THEN $6::timestamptz
                                                  ELSE delivery_target_expires_at END,
                  updated_at=NOW()
            WHERE connector_id=$1 AND external_conversation_id=$2 AND enabled=TRUE
        RETURNING id`,
        [
          input.connectorId,
          input.message.externalConversationId,
          JSON.stringify(dingTalkRoute ? dingTalkRouteMetadata(dingTalkRoute) : {}),
          refreshSession,
          input.encryptedReplyTarget ?? null,
          refreshSession ? expiresAt : null,
        ],
      );
      const bindingIds = bindings.rows.map((binding) => binding.id);
      if (bindingIds.length > 0) {
        const pendingJobs = await client.query<{
          id: string;
          kind: string;
          payload: Record<string, unknown>;
        }>(
          `SELECT id,kind,payload
             FROM connector_delivery_jobs
            WHERE connector_id=$1 AND status IN ('QUEUED','FAILED')
              AND payload->>'bindingId'=ANY($2::text[])
            FOR UPDATE`,
          [input.connectorId, bindingIds],
        );
        for (const job of pendingJobs.rows) {
          const payload: Record<string, unknown> = {
            ...job.payload,
            ...(dingTalkRoute ? { dingTalkRoute } : {}),
            ...(refreshSession
              ? {
                  encryptedDeliveryTarget: input.encryptedReplyTarget,
                  deliveryTargetExpiresAt: expiresAt.toISOString(),
                }
              : {}),
          };
          delete payload._idempotencyFingerprint;
          payload._idempotencyFingerprint = deliveryFingerprint(job.kind, payload);
          await client.query(
            `UPDATE connector_delivery_jobs
                SET payload=$2,status='QUEUED',attempts=0,next_attempt_at=NOW(),
                    lease_expires_at=NULL,error_message=NULL,updated_at=NOW()
              WHERE id=$1`,
            [job.id, payload],
          );
        }
      }
    }
  }
  if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
  const existing = await client.query<{ id: string; status: string }>(
    `SELECT id,status FROM connector_events WHERE connector_id=$1 AND external_event_id=$2`,
    [input.connectorId, input.message.externalEventId],
  );
  return { ...existing.rows[0]!, created: false };
}

export async function nextConnectorEvents(
  limit = 20,
  leaseSeconds = DEFAULT_EVENT_LEASE_SECONDS,
): Promise<ConnectorEventRow[]> {
  return transaction((client) => nextConnectorEventsWithClient(client, limit, leaseSeconds));
}

export async function nextConnectorEventsWithClient(
  client: PoolClient,
  limit = 20,
  leaseSeconds = DEFAULT_EVENT_LEASE_SECONDS,
): Promise<ConnectorEventRow[]> {
  await client.query(
    `UPDATE connector_events
        SET status=CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'RECEIVED' END,
            lease_expires_at=NULL,
            next_attempt_at=CASE WHEN attempts >= $1 THEN next_attempt_at ELSE NOW() END,
            error_message=CASE WHEN attempts >= $1 THEN '事件处理进程在完成前退出' ELSE error_message END
      WHERE status='PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())`,
    [MAX_ATTEMPTS],
  );
  const events = await client.query<ConnectorEventRow>(
    `WITH candidates AS (
       SELECT event.id
         FROM connector_events event
         JOIN connector_configs enabled_config ON enabled_config.id=event.connector_id
        WHERE event.status IN ('RECEIVED','FAILED') AND event.next_attempt_at<=NOW()
          AND event.attempts<$2 AND enabled_config.enabled=TRUE
        ORDER BY event.received_at FOR UPDATE OF event SKIP LOCKED LIMIT $1
     )
     UPDATE connector_events event
        SET status='PROCESSING',attempts=event.attempts+1,
            lease_expires_at=NOW()+make_interval(secs => $3),error_message=NULL
       FROM candidates,connector_configs config
      WHERE event.id=candidates.id AND config.id=event.connector_id AND config.enabled=TRUE
     RETURNING event.id,event.connector_id,config.provider,event.external_event_id,
               event.external_conversation_id,event.external_user_id,event.event_kind,
               event.payload,event.result,event.attempts`,
    [limit, MAX_ATTEMPTS, leaseSeconds],
  );
  return events.rows;
}

/** 先保存模型生成结果，再执行不具备事务性的外部 HTTP 投递；重试只复用该结果。 */
export async function cacheConnectorEventResult(
  id: string,
  result: Record<string, unknown>,
): Promise<void> {
  const updated = await query(
    `UPDATE connector_events SET result=result || $2::jsonb
      WHERE id=$1 AND status='PROCESSING'`,
    [id, result],
  );
  if (!updated.rowCount) throw new Error("连接器事件不再处于可缓存结果的处理状态");
}

export async function renewConnectorEventLease(
  id: string,
  leaseSeconds = DEFAULT_EVENT_LEASE_SECONDS,
): Promise<void> {
  const renewed = await query(
    `UPDATE connector_events
        SET lease_expires_at=NOW()+make_interval(secs => $2)
      WHERE id=$1 AND status='PROCESSING'`,
    [id, leaseSeconds],
  );
  if (!renewed.rowCount) throw new Error("连接器事件租约已失效");
}

export async function finishConnectorEvent(
  id: string,
  result: Record<string, unknown>,
  error?: unknown,
): Promise<void> {
  if (!error) {
    await query(
      `UPDATE connector_events
          SET status='PROCESSED',result=$2,processed_at=NOW(),lease_expires_at=NULL,
              error_message=NULL
        WHERE id=$1 AND status='PROCESSING'`,
      [id, result],
    );
    return;
  }
  const message = redactConnectorErrorMessage(error, "连接器事件处理失败");
  await query(
    `UPDATE connector_events
        SET status='FAILED',result=result || $2::jsonb,lease_expires_at=NULL,
            next_attempt_at=NOW()+make_interval(secs => LEAST(attempts*10,300)),error_message=$3
      WHERE id=$1 AND status='PROCESSING'`,
    [id, result, message],
  );
}

export const CONNECTOR_EVENT_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "CANCELLED",
] as const;
export type ConnectorEventStatus = (typeof CONNECTOR_EVENT_STATUSES)[number];
export const CONNECTOR_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type ConnectorJobStatus = (typeof CONNECTOR_JOB_STATUSES)[number];

interface EventOperationRow {
  id: string;
  connector_id: string;
  provider: ConnectorProvider;
  connector_name: string;
  external_event_id: string;
  external_conversation_id: string | null;
  external_user_id: string | null;
  event_kind: string;
  status: ConnectorEventStatus;
  attempts: number;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  error_message: string | null;
  received_at: Date;
  processed_at: Date | null;
  prepared: boolean;
  cursor_at: string;
}

interface JobOperationRow {
  id: string;
  connector_id: string;
  provider: ConnectorProvider;
  connector_name: string;
  kind: string;
  status: ConnectorJobStatus;
  attempts: number;
  idempotency_key: string;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
}

export async function listConnectorEventsForAdmin(input: {
  connectorId?: string;
  status?: ConnectorEventStatus;
  limit: number;
  before?: string;
  beforeId?: string;
}) {
  if (Boolean(input.before) !== Boolean(input.beforeId)) {
    throw new ApiError(400, "队列分页 before 与 beforeId 必须同时提供");
  }
  const result = await query<EventOperationRow>(
    `SELECT event.id,event.connector_id,config.provider,config.name AS connector_name,
            event.external_event_id,event.external_conversation_id,event.external_user_id,
            event.event_kind,event.status,event.attempts,event.next_attempt_at,
            event.lease_expires_at,event.error_message,event.received_at,event.processed_at,
            COALESCE(event.result->>'prepared'='true',FALSE) AS prepared,
            to_char(event.received_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM connector_events event
       JOIN connector_configs config ON config.id=event.connector_id
      WHERE ($1::uuid IS NULL OR event.connector_id=$1)
        AND ($2::varchar IS NULL OR event.status=$2)
        AND ($3::timestamptz IS NULL OR
             (event.received_at,event.id)<($3::timestamptz,$4::uuid))
      ORDER BY event.received_at DESC,event.id DESC LIMIT $5`,
    [
      input.connectorId ?? null,
      input.status ?? null,
      input.before ?? null,
      input.beforeId ?? null,
      input.limit + 1,
    ],
  );
  const hasMore = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);
  const items = rows.map((row) => ({
    id: row.id,
    connectorId: row.connector_id,
    provider: row.provider,
    connectorName: row.connector_name,
    externalEventId: row.external_event_id,
    externalConversationId: row.external_conversation_id,
    externalUserId: row.external_user_id,
    kind: row.event_kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    error: row.error_message ? redactConnectorErrorMessage(row.error_message) : null,
    receivedAt: row.received_at.toISOString(),
    processedAt: row.processed_at?.toISOString() ?? null,
    prepared: row.prepared,
  }));
  const last = rows.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? { before: last.cursor_at, beforeId: last.id } : null,
  };
}

export async function listConnectorJobsForAdmin(input: {
  connectorId?: string;
  status?: ConnectorJobStatus;
  limit: number;
  before?: string;
  beforeId?: string;
}) {
  if (Boolean(input.before) !== Boolean(input.beforeId)) {
    throw new ApiError(400, "队列分页 before 与 beforeId 必须同时提供");
  }
  const result = await query<JobOperationRow>(
    `SELECT job.id,job.connector_id,config.provider,config.name AS connector_name,
            job.kind,job.status,job.attempts,job.idempotency_key,job.next_attempt_at,
            job.lease_expires_at,job.error_message,job.created_at,job.updated_at,
            to_char(job.updated_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM connector_delivery_jobs job
       JOIN connector_configs config ON config.id=job.connector_id
      WHERE ($1::uuid IS NULL OR job.connector_id=$1)
        AND ($2::varchar IS NULL OR job.status=$2)
        AND ($3::timestamptz IS NULL OR
             (job.updated_at,job.id)<($3::timestamptz,$4::uuid))
      ORDER BY job.updated_at DESC,job.id DESC LIMIT $5`,
    [
      input.connectorId ?? null,
      input.status ?? null,
      input.before ?? null,
      input.beforeId ?? null,
      input.limit + 1,
    ],
  );
  const hasMore = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);
  const items = rows.map((row) => ({
    id: row.id,
    connectorId: row.connector_id,
    provider: row.provider,
    connectorName: row.connector_name,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    error: row.error_message ? redactConnectorErrorMessage(row.error_message) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
  const last = rows.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? { before: last.cursor_at, beforeId: last.id } : null,
  };
}

interface QueueHealthRow {
  operation_type: "EVENT" | "JOB";
  status: string;
  total: string;
  oldest_at: Date;
}

export async function connectorQueueHealth() {
  const result = await query<QueueHealthRow>(
    `SELECT 'EVENT'::text AS operation_type,status,COUNT(*)::text AS total,
            MIN(received_at) AS oldest_at
       FROM connector_events GROUP BY status
      UNION ALL
     SELECT 'JOB'::text AS operation_type,status,COUNT(*)::text AS total,
            MIN(created_at) AS oldest_at
       FROM connector_delivery_jobs GROUP BY status`,
  );
  const summarize = (type: QueueHealthRow["operation_type"]) => {
    const rows = result.rows.filter((row) => row.operation_type === type);
    return {
      counts: Object.fromEntries(rows.map((row) => [row.status, Number(row.total)])),
      total: rows.reduce((total, row) => total + Number(row.total), 0),
      oldestAt:
        rows.length > 0
          ? new Date(Math.min(...rows.map((row) => row.oldest_at.getTime()))).toISOString()
          : null,
    };
  };
  return {
    events: summarize("EVENT"),
    jobs: summarize("JOB"),
    checkedAt: new Date().toISOString(),
  };
}

export async function retryConnectorEvent(id: string) {
  return transaction(async (client) => {
    const selected = await client.query<{
      id: string;
      connector_id: string;
      external_conversation_id: string;
      external_user_id: string;
      status: ConnectorEventStatus;
      result: Record<string, unknown>;
    }>(
      `SELECT id,connector_id,external_conversation_id,external_user_id,status,result
         FROM connector_events WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const event = selected.rows[0];
    if (!event || (event.status !== "FAILED" && event.status !== "CANCELLED")) {
      throw new ApiError(409, "连接器事件不存在或当前状态不允许重试");
    }
    const connector = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM connector_configs WHERE id=$1`,
      [event.connector_id],
    );
    if (!connector.rows[0]?.enabled) {
      throw new ApiError(409, "连接器已停用，不能重试事件");
    }
    if (event.result.disposition === "REPLIED") {
      const expected = parseStoredEventAuthorization(event.result.authorization);
      if (!expected) throw new ApiError(409, "缓存回复缺少可验证的授权快照，不能重试");
      const current = await client.query<ConnectorEventAuthorizationRow>(
        CONNECTOR_EVENT_AUTHORIZATION_SQL,
        [event.connector_id, event.external_conversation_id, event.external_user_id],
      );
      if (!sameStoredEventAuthorization(expected, toConnectorEventAuthorization(current.rows[0]))) {
        throw new ApiError(409, "连接器回复授权已变更，不能重试旧事件");
      }
    }
    const result = await client.query<{
      id: string;
      connector_id: string;
      status: ConnectorEventStatus;
    }>(
      `UPDATE connector_events
          SET status='RECEIVED',attempts=0,next_attempt_at=NOW(),lease_expires_at=NULL,
              error_message=NULL,processed_at=NULL
        WHERE id=$1
      RETURNING id,connector_id,status`,
      [id],
    );
    return result.rows[0]!;
  });
}

export async function cancelConnectorEvent(id: string) {
  const result = await query<{ id: string; connector_id: string; status: ConnectorEventStatus }>(
    `UPDATE connector_events
        SET status='CANCELLED',lease_expires_at=NULL,
            error_message=COALESCE(error_message,'管理员取消')
      WHERE id=$1 AND status IN ('RECEIVED','FAILED')
    RETURNING id,connector_id,status`,
    [id],
  );
  if (!result.rows[0]) throw new ApiError(409, "连接器事件不存在或当前状态不允许取消");
  return result.rows[0];
}

export async function retryConnectorJob(id: string) {
  return transaction(async (client) => {
    const selected = await client.query<{
      id: string;
      connector_id: string;
      kind: string;
      status: ConnectorJobStatus;
      payload: Record<string, unknown>;
    }>(
      `SELECT id,connector_id,kind,status,payload
         FROM connector_delivery_jobs WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const job = selected.rows[0];
    if (!job || (job.status !== "FAILED" && job.status !== "CANCELLED")) {
      throw new ApiError(409, "连接器投递不存在或当前状态不允许重试");
    }
    const connector = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM connector_configs WHERE id=$1`,
      [job.connector_id],
    );
    if (!connector.rows[0]?.enabled) {
      throw new ApiError(409, "连接器已停用，不能重试投递");
    }
    const payload = { ...job.payload };
    const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : null;
    if (bindingId) {
      const binding = await client.query<{
        delivery_target_encrypted: string | null;
        delivery_target_expires_at: Date | null;
        metadata: Record<string, unknown>;
        provider: ConnectorProvider;
        binding_enabled: boolean;
        config_enabled: boolean;
        delivery_kinds: ConnectorDeliveryKind[];
        owner_id: string;
      }>(
        // job 行锁先拿；并发 binding/config 变更会在本事务提交后以 CANCELLED 收敛，
        // 此处只读当前授权，避免反向获取 binding/config 锁造成死锁。
        `SELECT binding.delivery_target_encrypted,binding.delivery_target_expires_at,
                binding.metadata,config.provider,binding.enabled AS binding_enabled,
                config.enabled AS config_enabled,binding.delivery_kinds,binding.owner_id
           FROM connector_bindings binding
           JOIN connector_configs config ON config.id=binding.connector_id
           JOIN users owner ON owner.id=binding.owner_id AND owner.enabled=TRUE
          WHERE binding.id=$1 AND binding.connector_id=$2
          `,
        [bindingId, job.connector_id],
      );
      const currentBinding = binding.rows[0];
      if (
        !currentBinding ||
        !currentBinding.binding_enabled ||
        !currentBinding.config_enabled ||
        !currentBinding.delivery_kinds.includes(job.kind as ConnectorDeliveryKind) ||
        typeof payload.bindingOwnerId !== "string" ||
        payload.bindingOwnerId !== currentBinding.owner_id
      ) {
        throw new ApiError(409, "连接器绑定已删除、停用或不再允许该类投递");
      }
      payload.encryptedDeliveryTarget = currentBinding.delivery_target_encrypted;
      payload.deliveryTargetExpiresAt =
        currentBinding.delivery_target_expires_at?.toISOString() ?? null;
      if (currentBinding.provider === "DINGTALK_STREAM") {
        payload.dingTalkRoute = tryParseDingTalkDeliveryRoute(currentBinding.metadata);
      }
      delete payload._idempotencyFingerprint;
      payload._idempotencyFingerprint = deliveryFingerprint(job.kind, payload);
    }
    const result = await client.query<{
      id: string;
      connector_id: string;
      status: ConnectorJobStatus;
    }>(
      `UPDATE connector_delivery_jobs
          SET status='QUEUED',attempts=0,next_attempt_at=NOW(),lease_expires_at=NULL,
              error_message=NULL,payload=$2,updated_at=NOW()
        WHERE id=$1
      RETURNING id,connector_id,status`,
      [id, payload],
    );
    return result.rows[0]!;
  });
}

export async function cancelConnectorJob(id: string) {
  const result = await query<{ id: string; connector_id: string; status: ConnectorJobStatus }>(
    `UPDATE connector_delivery_jobs
        SET status='CANCELLED',lease_expires_at=NULL,
            error_message=COALESCE(error_message,'管理员取消'),updated_at=NOW()
      WHERE id=$1 AND status IN ('QUEUED','FAILED')
    RETURNING id,connector_id,status`,
    [id],
  );
  if (!result.rows[0]) throw new ApiError(409, "连接器投递不存在或当前状态不允许取消");
  return result.rows[0];
}

function toIdentity(row: IdentityRow): ConnectorIdentity {
  return {
    id: row.id,
    connectorId: row.connector_id,
    externalUserId: row.external_user_id,
    nearChatUserId: row.near_chat_user_id,
    displayName: row.display_name,
    metadata: row.metadata,
  };
}

function toBinding(row: BindingRow): ConnectorBinding {
  const dingTalkRoute =
    row.provider === "DINGTALK_STREAM" ? tryParseDingTalkDeliveryRoute(row.metadata) : null;
  return {
    id: row.id,
    connectorId: row.connector_id,
    ownerId: row.owner_id,
    externalConversationId: row.external_conversation_id,
    nearChatConversationId: row.near_chat_conversation_id,
    assistantId: row.assistant_id,
    deliveryKinds: row.delivery_kinds,
    hasDeliveryTarget: Boolean(row.delivery_target_encrypted),
    hasDingTalkOpenApiRoute: Boolean(dingTalkRoute),
    deliveryTargetExpiresAt: row.delivery_target_expires_at?.toISOString() ?? null,
    enabled: row.enabled,
    metadata: publicBindingMetadata(row.provider, row.metadata),
  };
}

export async function upsertConnectorIdentity(input: {
  connectorId: string;
  externalUserId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}): Promise<ConnectorIdentity> {
  const result = await query<IdentityRow>(
    `INSERT INTO connector_identities
       (id,connector_id,external_user_id,display_name,metadata)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (connector_id,external_user_id) DO UPDATE
       SET display_name=EXCLUDED.display_name,
           metadata=connector_identities.metadata || EXCLUDED.metadata,updated_at=NOW()
     RETURNING id,connector_id,external_user_id,near_chat_user_id,display_name,metadata`,
    [
      randomUUID(),
      input.connectorId,
      input.externalUserId,
      input.displayName,
      input.metadata ?? {},
    ],
  );
  return toIdentity(result.rows[0]!);
}

export async function mapConnectorIdentity(input: {
  connectorId: string;
  externalUserId: string;
  nearChatUserId: string | null;
}): Promise<ConnectorIdentity> {
  return transaction(async (client) => {
    if (input.nearChatUserId) {
      const user = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id=$1 AND enabled=TRUE`,
        [input.nearChatUserId],
      );
      if (!user.rows[0]) throw new ApiError(400, "映射用户不存在或已停用");
    }
    const selected = await client.query<IdentityRow>(
      `SELECT id,connector_id,external_user_id,near_chat_user_id,display_name,metadata
         FROM connector_identities
        WHERE connector_id=$1 AND external_user_id=$2
        FOR UPDATE`,
      [input.connectorId, input.externalUserId],
    );
    const previous = selected.rows[0];
    if (!previous) throw new ApiError(404, "外部身份不存在，请先让该用户发送一条消息");
    const result = await client.query<IdentityRow>(
      `UPDATE connector_identities SET near_chat_user_id=$3,updated_at=NOW()
        WHERE connector_id=$1 AND external_user_id=$2
        RETURNING id,connector_id,external_user_id,near_chat_user_id,display_name,metadata`,
      [input.connectorId, input.externalUserId, input.nearChatUserId],
    );
    if (previous.near_chat_user_id !== input.nearChatUserId) {
      // 已生成但未外发的回复属于旧身份授权，解绑/重映射后不得复活。
      await client.query(
        `UPDATE connector_events
            SET status='CANCELLED',lease_expires_at=NULL,
                error_message=COALESCE(error_message,'外部身份映射已变更')
          WHERE connector_id=$1 AND external_user_id=$2
            AND status IN ('RECEIVED','FAILED')`,
        [input.connectorId, input.externalUserId],
      );
    }
    return toIdentity(result.rows[0]);
  });
}

export async function listConnectorIdentities(connectorId: string): Promise<ConnectorIdentity[]> {
  return (
    await query<IdentityRow>(
      `SELECT id,connector_id,external_user_id,near_chat_user_id,display_name,metadata
         FROM connector_identities WHERE connector_id=$1 ORDER BY updated_at DESC`,
      [connectorId],
    )
  ).rows.map(toIdentity);
}

export async function findConnectorBinding(
  connectorId: string,
  externalConversationId: string,
): Promise<ConnectorBinding | null> {
  const result = await query<BindingRow>(
    `SELECT binding.id,binding.connector_id,binding.owner_id,binding.external_conversation_id,
            binding.near_chat_conversation_id,binding.assistant_id,binding.delivery_kinds,
            binding.delivery_target_encrypted,binding.delivery_target_expires_at,binding.enabled,
            binding.metadata,config.provider
       FROM connector_bindings binding
       JOIN connector_configs config ON config.id=binding.connector_id
       JOIN users owner ON owner.id=binding.owner_id AND owner.enabled=TRUE
      WHERE binding.connector_id=$1 AND binding.external_conversation_id=$2
        AND binding.enabled=TRUE AND config.enabled=TRUE`,
    [connectorId, externalConversationId],
  );
  return result.rows[0] ? toBinding(result.rows[0]) : null;
}

/** 缓存回复外发前重新读取当前授权，防止解绑、重绑或账号停用后复活旧回复。 */
export async function currentConnectorEventAuthorization(
  connectorId: string,
  externalConversationId: string,
  externalUserId: string,
): Promise<ConnectorEventAuthorizationSnapshot | null> {
  const result = await query<ConnectorEventAuthorizationRow>(CONNECTOR_EVENT_AUTHORIZATION_SQL, [
    connectorId,
    externalConversationId,
    externalUserId,
  ]);
  return toConnectorEventAuthorization(result.rows[0]);
}

export async function listConnectorBindings(connectorId: string): Promise<ConnectorBinding[]> {
  return (
    await query<BindingRow>(
      `SELECT binding.id,binding.connector_id,binding.owner_id,binding.external_conversation_id,
              binding.near_chat_conversation_id,binding.assistant_id,binding.delivery_kinds,
              binding.delivery_target_encrypted,binding.delivery_target_expires_at,binding.enabled,
              binding.metadata,config.provider
         FROM connector_bindings binding
         JOIN connector_configs config ON config.id=binding.connector_id
        WHERE binding.connector_id=$1 ORDER BY binding.updated_at DESC`,
      [connectorId],
    )
  ).rows.map(toBinding);
}

export async function saveConnectorBinding(input: {
  id?: string;
  connectorId: string;
  ownerId: string;
  externalConversationId: string;
  nearChatConversationId?: string | null;
  assistantId?: string | null;
  deliveryKinds: ConnectorDeliveryKind[];
  deliveryTarget?: string | null;
  deliveryTargetExpiresAt?: string | null;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}): Promise<ConnectorBinding> {
  return transaction(async (client) => {
    const connector = await client.query<{ provider: ConnectorProvider }>(
      `SELECT provider FROM connector_configs WHERE id=$1 FOR SHARE`,
      [input.connectorId],
    );
    const provider = connector.rows[0]?.provider;
    if (!provider) throw new ApiError(404, "连接器不存在");
    // 统一锁顺序 config -> owner/assistant -> binding -> event -> job；尤其新建 binding
    // 必须让账号停用等待到 INSERT 后再扫描，不能在重新启用账号时意外复活。
    const owner = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id=$1 AND enabled=TRUE FOR SHARE`,
      [input.ownerId],
    );
    if (!owner.rows[0]) throw new ApiError(400, "绑定用户不存在或已停用");
    if (input.assistantId) {
      const assistant = await client.query<{ id: string }>(
        `SELECT id FROM ai_assistants
          WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL
          FOR SHARE`,
        [input.assistantId, input.ownerId],
      );
      if (!assistant.rows[0]) throw new ApiError(400, "只能绑定该用户自己的智能助理");
    }
    if (input.nearChatConversationId) {
      const membership = await client.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM conversation_members
          WHERE conversation_id=$1 AND user_id=$2`,
        [input.nearChatConversationId, input.ownerId],
      );
      if (!membership.rows[0]) throw new ApiError(400, "只能绑定该用户有权访问的 NearChat 会话");
    }
    const existing = await client.query<{
      id: string;
      owner_id: string;
      external_conversation_id: string;
      near_chat_conversation_id: string | null;
      assistant_id: string | null;
      enabled: boolean;
      delivery_target_encrypted: string | null;
      delivery_target_expires_at: Date | null;
      delivery_kinds: ConnectorDeliveryKind[];
      metadata: Record<string, unknown>;
    }>(
      input.id
        ? `SELECT id,owner_id,external_conversation_id,near_chat_conversation_id,
                  assistant_id,enabled,delivery_target_encrypted,
                  delivery_target_expires_at,delivery_kinds,metadata
             FROM connector_bindings
            WHERE id=$1 AND connector_id=$2 FOR UPDATE`
        : `SELECT id,owner_id,external_conversation_id,near_chat_conversation_id,
                  assistant_id,enabled,delivery_target_encrypted,
                  delivery_target_expires_at,delivery_kinds,metadata
             FROM connector_bindings
            WHERE connector_id=$1 AND external_conversation_id=$2 FOR UPDATE`,
      input.id ? [input.id, input.connectorId] : [input.connectorId, input.externalConversationId],
    );
    if (input.id && !existing.rows[0]) throw new ApiError(404, "连接器绑定不存在");
    if (
      input.id &&
      existing.rows[0] &&
      input.externalConversationId !== existing.rows[0].external_conversation_id
    ) {
      throw new ApiError(409, "已有绑定的外部会话不可更改，请删除后重新绑定");
    }
    if (existing.rows[0] && input.ownerId !== existing.rows[0].owner_id) {
      throw new ApiError(409, "已有绑定的所属用户不可更改，请删除后重新绑定");
    }
    let authoritativeMetadata = existing.rows[0]?.metadata ?? {};
    if (provider === "DINGTALK_STREAM") {
      const latestEvent = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM connector_events
          WHERE connector_id=$1 AND external_conversation_id=$2
            AND payload ? 'dingTalkRoute'
          ORDER BY received_at DESC,id DESC LIMIT 1`,
        [input.connectorId, input.externalConversationId],
      );
      const latestRoute = tryParseDingTalkDeliveryRoute(latestEvent.rows[0]?.payload.dingTalkRoute);
      if (latestRoute) {
        authoritativeMetadata = {
          ...authoritativeMetadata,
          ...dingTalkRouteMetadata(latestRoute),
        };
      }
    }
    const normalizedTarget = input.deliveryTarget?.trim() || null;
    const targetEncrypted =
      input.deliveryTarget === undefined
        ? (existing.rows[0]?.delivery_target_encrypted ?? null)
        : normalizedTarget
          ? encryptAiSecret(normalizedTarget)
          : null;
    const targetExpiresAt =
      input.deliveryTarget === null
        ? null
        : input.deliveryTargetExpiresAt === undefined
          ? (existing.rows[0]?.delivery_target_expires_at ?? null)
          : input.deliveryTargetExpiresAt === null
            ? null
            : futureTimestamp(
                input.deliveryTargetExpiresAt,
                "钉钉会话 Webhook 必须填写尚未过期的失效时间",
              );
    if (input.deliveryKinds.length > 0 && provider === "WECOM_CALLBACK" && !targetEncrypted) {
      throw new ApiError(400, "该连接器启用主动投递时必须填写外部投递目标");
    }
    if (normalizedTarget) {
      if (provider === "DINGTALK_STREAM") {
        try {
          validateDingTalkSessionWebhook(normalizedTarget);
        } catch {
          throw new ApiError(400, "钉钉投递目标必须是有效的会话 Webhook");
        }
        if (!targetExpiresAt) {
          throw new ApiError(400, "钉钉会话 Webhook 必须填写尚未过期的失效时间");
        }
      } else if (provider === "WECOM_WEBHOOK") {
        throw new ApiError(400, "企业微信群机器人投递目标已由连接器配置确定");
      } else {
        try {
          validateWeComUserId(normalizedTarget);
        } catch {
          throw new ApiError(400, "企业微信投递目标必须是单一成员账号，不能使用广播目标");
        }
      }
    }
    const values = [
      existing.rows[0]?.id ?? input.id ?? randomUUID(),
      input.connectorId,
      input.ownerId,
      input.externalConversationId,
      input.nearChatConversationId ?? null,
      input.assistantId ?? null,
      input.deliveryKinds,
      targetEncrypted,
      provider === "DINGTALK_STREAM" ? targetExpiresAt : null,
      input.enabled,
      bindingMetadataForSave(provider, authoritativeMetadata, input.metadata),
    ];
    let result;
    try {
      result = existing.rows[0]
        ? await client.query<BindingRow>(
            `UPDATE connector_bindings
                SET owner_id=$3,external_conversation_id=$4,near_chat_conversation_id=$5,
                    assistant_id=$6,delivery_kinds=$7,delivery_target_encrypted=$8,
                    delivery_target_expires_at=$9,enabled=$10,metadata=$11,updated_at=NOW()
              WHERE id=$1 AND connector_id=$2
            RETURNING id,connector_id,owner_id,external_conversation_id,near_chat_conversation_id,
                      assistant_id,delivery_kinds,delivery_target_encrypted,
                      delivery_target_expires_at,enabled,metadata`,
            values,
          )
        : await client.query<BindingRow>(
            `INSERT INTO connector_bindings
               (id,connector_id,owner_id,external_conversation_id,near_chat_conversation_id,
                assistant_id,delivery_kinds,delivery_target_encrypted,
                delivery_target_expires_at,enabled,metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id,connector_id,owner_id,external_conversation_id,near_chat_conversation_id,
                       assistant_id,delivery_kinds,delivery_target_encrypted,
                       delivery_target_expires_at,enabled,metadata`,
            values,
          );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ApiError(409, "该连接器的外部会话已经绑定");
      }
      throw error;
    }
    if (existing.rows[0]) {
      const previous = existing.rows[0];
      const authorizationChanged =
        previous.owner_id !== input.ownerId ||
        previous.assistant_id !== (input.assistantId ?? null) ||
        previous.near_chat_conversation_id !== (input.nearChatConversationId ?? null) ||
        previous.enabled !== input.enabled;
      // 所有撤权事务统一按 event -> job 获取队列行锁，避免与 connector/user 停用死锁。
      if (authorizationChanged) {
        await client.query(
          `UPDATE connector_events
              SET status='CANCELLED',lease_expires_at=NULL,
                  error_message=COALESCE(error_message,'连接器绑定授权已变更')
            WHERE connector_id=$1 AND external_conversation_id=$2
              AND status IN ('RECEIVED','FAILED')`,
          [input.connectorId, previous.external_conversation_id],
        );
      }
      await client.query(
        `UPDATE connector_delivery_jobs
            SET status='CANCELLED',lease_expires_at=NULL,
                error_message=COALESCE(error_message,'绑定已停用或不再允许该类投递'),
                updated_at=NOW()
          WHERE connector_id=$1 AND payload->>'bindingId'=$2
            AND status IN ('QUEUED','FAILED')
            AND ($3::boolean=FALSE OR $5::boolean=TRUE OR NOT (kind=ANY($4::varchar[])))`,
        [input.connectorId, previous.id, input.enabled, input.deliveryKinds, authorizationChanged],
      );
      const pending = await client.query<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id,kind,payload FROM connector_delivery_jobs
          WHERE connector_id=$1 AND payload->>'bindingId'=$2
            AND status IN ('QUEUED','FAILED') FOR UPDATE`,
        [input.connectorId, existing.rows[0].id],
      );
      const saved = result.rows[0]!;
      for (const job of pending.rows) {
        const payload: Record<string, unknown> = {
          ...job.payload,
          bindingOwnerId: saved.owner_id,
          encryptedDeliveryTarget: saved.delivery_target_encrypted,
          deliveryTargetExpiresAt: saved.delivery_target_expires_at?.toISOString() ?? null,
          ...(provider === "DINGTALK_STREAM"
            ? { dingTalkRoute: tryParseDingTalkDeliveryRoute(saved.metadata) }
            : {}),
        };
        delete payload._idempotencyFingerprint;
        payload._idempotencyFingerprint = deliveryFingerprint(job.kind, payload);
        await client.query(
          `UPDATE connector_delivery_jobs SET payload=$2,updated_at=NOW() WHERE id=$1`,
          [job.id, payload],
        );
      }
    }
    return toBinding({ ...result.rows[0]!, provider });
  });
}

export async function deleteConnectorBinding(
  connectorId: string,
  bindingId: string,
): Promise<void> {
  await transaction(async (client) => {
    const result = await client.query<{ id: string; external_conversation_id: string }>(
      `DELETE FROM connector_bindings
        WHERE id=$1 AND connector_id=$2
      RETURNING id,external_conversation_id`,
      [bindingId, connectorId],
    );
    if (!result.rowCount) throw new ApiError(404, "连接器绑定不存在");
    await client.query(
      `UPDATE connector_events
          SET status='CANCELLED',lease_expires_at=NULL,
              error_message=COALESCE(error_message,'连接器绑定已删除')
        WHERE connector_id=$1 AND external_conversation_id=$2
          AND status IN ('RECEIVED','FAILED')`,
      [connectorId, result.rows[0]!.external_conversation_id],
    );
    await client.query(
      `UPDATE connector_delivery_jobs
          SET status='CANCELLED',lease_expires_at=NULL,
              error_message=COALESCE(error_message,'绑定已删除'),updated_at=NOW()
        WHERE connector_id=$1 AND payload->>'bindingId'=$2
          AND status IN ('QUEUED','FAILED')`,
      [connectorId, bindingId],
    );
  });
}

export async function saveConnectorMessageLink(input: {
  connectorId: string;
  externalMessageId: string;
  direction: "INBOUND" | "OUTBOUND";
  eventId?: string;
  deliveryJobId?: string;
  nearChatMessageId?: string;
}): Promise<void> {
  await query(
    `INSERT INTO connector_message_links
       (id,connector_id,external_message_id,direction,event_id,delivery_job_id,near_chat_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (connector_id,external_message_id,direction) DO UPDATE
       SET event_id=COALESCE(EXCLUDED.event_id,connector_message_links.event_id),
           delivery_job_id=COALESCE(EXCLUDED.delivery_job_id,connector_message_links.delivery_job_id),
           near_chat_message_id=COALESCE(EXCLUDED.near_chat_message_id,connector_message_links.near_chat_message_id)`,
    [
      randomUUID(),
      input.connectorId,
      input.externalMessageId,
      input.direction,
      input.eventId ?? null,
      input.deliveryJobId ?? null,
      input.nearChatMessageId ?? null,
    ],
  );
}

export function encryptConnectorReplyTarget(value: string): string {
  return encryptAiSecret(value);
}

export function decryptConnectorReplyTarget(value: string): string {
  return decryptAiSecret(value);
}

export function isConnectorProvider(value: string): value is ConnectorProvider {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(value);
}
