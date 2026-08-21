import type { ConnectorConfigInput } from "../api";
import type {
  ConnectorBinding,
  ConnectorConfig,
  ConnectorDeliveryKind,
  ConnectorProvider,
} from "../types";

export interface ConnectorDraft {
  provider: ConnectorProvider;
  name: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  webhookUrl: string;
  callbackToken: string;
  encodingAesKey: string;
  corpId: string;
  agentId: string;
}

export interface BindingDraft {
  id?: string;
  ownerId: string;
  externalConversationId: string;
  nearChatConversationId: string;
  assistantId: string;
  deliveryKinds: ConnectorDeliveryKind[];
  deliveryTarget: string;
  deliveryTargetExpiresAt: string;
  deliveryTargetExpiryChanged: boolean;
  hasExistingDeliveryTarget: boolean;
  hasDingTalkOpenApiRoute: boolean;
  clearDeliveryTarget: boolean;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export type ConnectorField = keyof ConnectorConfigInput;

export const providerInfo: Record<
  ConnectorProvider,
  { name: string; description: string; inbound: boolean }
> = {
  DINGTALK_STREAM: {
    name: "钉钉机器人",
    description: "Stream 双向消息与会话凭据有效期内投递",
    inbound: true,
  },
  WECOM_WEBHOOK: {
    name: "企业微信群机器人",
    description: "群机器人 Webhook 主动投递",
    inbound: false,
  },
  WECOM_CALLBACK: {
    name: "企业微信自建应用",
    description: "加密回调入站与应用消息出站",
    inbound: true,
  },
};

export const configFields: Record<
  ConnectorProvider,
  Array<{ key: ConnectorField; label: string; placeholder: string; secret?: boolean }>
> = {
  DINGTALK_STREAM: [
    { key: "clientId", label: "Client ID", placeholder: "应用 Client ID" },
    {
      key: "clientSecret",
      label: "Client Secret",
      placeholder: "应用 Client Secret",
      secret: true,
    },
  ],
  WECOM_WEBHOOK: [
    {
      key: "webhookUrl",
      label: "机器人 Webhook",
      placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
      secret: true,
    },
  ],
  WECOM_CALLBACK: [
    { key: "corpId", label: "Corp ID", placeholder: "企业 ID" },
    { key: "agentId", label: "Agent ID", placeholder: "自建应用 Agent ID" },
    {
      key: "clientSecret",
      label: "应用 Secret",
      placeholder: "自建应用 Secret",
      secret: true,
    },
    {
      key: "callbackToken",
      label: "回调 Token",
      placeholder: "回调配置中的 Token",
      secret: true,
    },
    {
      key: "encodingAesKey",
      label: "EncodingAESKey",
      placeholder: "43 位 EncodingAESKey",
      secret: true,
    },
  ],
};

export const configuredFlags: Record<ConnectorField, keyof ConnectorConfig> = {
  clientId: "hasClientId",
  clientSecret: "hasClientSecret",
  webhookUrl: "hasWebhookUrl",
  callbackToken: "hasCallbackToken",
  encodingAesKey: "hasEncodingAesKey",
  corpId: "hasCorpId",
  agentId: "hasAgentId",
};

export const deliveryKindLabels: Record<ConnectorDeliveryKind, string> = {
  TASK_RESULT: "任务结果",
  REMINDER: "提醒",
  SUMMARY: "摘要",
  TEXT: "普通文本",
};

export const emptyConnectorDraft: ConnectorDraft = {
  provider: "DINGTALK_STREAM",
  name: "",
  enabled: false,
  clientId: "",
  clientSecret: "",
  webhookUrl: "",
  callbackToken: "",
  encodingAesKey: "",
  corpId: "",
  agentId: "",
};

export function emptyBindingDraft(ownerId: string): BindingDraft {
  return {
    ownerId,
    externalConversationId: "",
    nearChatConversationId: "",
    assistantId: "",
    deliveryKinds: [],
    deliveryTarget: "",
    deliveryTargetExpiresAt: "",
    deliveryTargetExpiryChanged: false,
    hasExistingDeliveryTarget: false,
    hasDingTalkOpenApiRoute: false,
    clearDeliveryTarget: false,
    enabled: true,
  };
}

export function toDatetimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function bindingDraftFromBinding(binding: ConnectorBinding): BindingDraft {
  return {
    id: binding.id,
    ownerId: binding.ownerId,
    externalConversationId: binding.externalConversationId,
    nearChatConversationId: binding.nearChatConversationId ?? "",
    assistantId: binding.assistantId ?? "",
    deliveryKinds: binding.deliveryKinds,
    deliveryTarget: "",
    deliveryTargetExpiresAt: toDatetimeLocal(binding.deliveryTargetExpiresAt),
    deliveryTargetExpiryChanged: false,
    hasExistingDeliveryTarget: binding.hasDeliveryTarget,
    hasDingTalkOpenApiRoute: binding.hasDingTalkOpenApiRoute,
    clearDeliveryTarget: false,
    enabled: binding.enabled,
    metadata: binding.metadata,
  };
}

export function connectorWithRuntime(
  connector: ConnectorConfig,
  runtime: { running: boolean; error: string | null },
): ConnectorConfig {
  return {
    ...connector,
    runtime: {
      running: runtime.running,
      error: runtime.error,
      startedAt: runtime.running ? connector.runtime.startedAt : null,
    },
  };
}
