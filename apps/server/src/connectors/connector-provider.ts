export const CONNECTOR_PROVIDERS = ["DINGTALK_STREAM", "WECOM_WEBHOOK", "WECOM_CALLBACK"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export interface ConnectorConfigPayload {
  clientId?: string;
  clientSecret?: string;
  webhookUrl?: string;
  callbackToken?: string;
  encodingAesKey?: string;
  corpId?: string;
  agentId?: string;
}

export type ConnectorConfigPatch = {
  [Key in keyof ConnectorConfigPayload]?: ConnectorConfigPayload[Key] | null;
};

export const CONNECTOR_DELIVERY_KINDS = ["TASK_RESULT", "REMINDER", "SUMMARY", "TEXT"] as const;
export type ConnectorDeliveryKind = (typeof CONNECTOR_DELIVERY_KINDS)[number];

export interface ConnectorDelivery {
  id: string;
  connectorId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface ConnectorProviderDriver {
  readonly provider: ConnectorProvider;
  deliver(
    config: ConnectorConfigPayload,
    job: ConnectorDelivery,
  ): Promise<{ externalMessageId?: string } | void>;
}

export interface ConnectorIdentity {
  id: string;
  connectorId: string;
  externalUserId: string;
  nearChatUserId: string | null;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorBinding {
  id: string;
  connectorId: string;
  ownerId: string;
  externalConversationId: string;
  nearChatConversationId: string | null;
  assistantId: string | null;
  deliveryKinds: ConnectorDeliveryKind[];
  hasDeliveryTarget: boolean;
  hasDingTalkOpenApiRoute: boolean;
  deliveryTargetExpiresAt: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface ConnectorInboundTextMessage {
  connectorId: string;
  provider: "DINGTALK_STREAM" | "WECOM_CALLBACK";
  externalEventId: string;
  externalMessageId: string;
  externalConversationId: string;
  externalUserId: string;
  externalUserName: string;
  text: string;
  occurredAt: string;
}

export interface ConnectorInboundContext {
  eventId: string;
  message: ConnectorInboundTextMessage;
  identity: ConnectorIdentity;
  binding: ConnectorBinding | null;
}

export interface ConnectorInboundResult {
  replyText?: string;
  nearChatMessageId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 根应用在启动时注册一次领域处理器。连接器层只负责协议、安全、幂等和映射，
 * 不直接依赖聊天、记忆或助理领域，避免外部平台故障污染核心调用链。
 */
export type ConnectorInboundMessageHandler = (
  context: ConnectorInboundContext,
) => Promise<ConnectorInboundResult | void>;
