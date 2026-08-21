import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import {
  DingTalkSessionUnavailableError,
  parseDingTalkDeliveryRoute,
  parseDingTalkRobotText,
  sendDingTalkOpenApiText,
  sendDingTalkSessionReply,
  validateDingTalkSessionWebhook,
  type DingTalkDeliveryRoute,
  type DingTalkOpenApiOptions,
} from "./dingtalk-connector.js";
import { fetchWithTimeout, readJsonResponse } from "./connector-http.js";
import { processConnectorInboundEvent, type ProcessedConnectorEvent } from "./connector-inbound.js";
import type {
  ConnectorConfigPayload,
  ConnectorDelivery,
  ConnectorProviderDriver,
  ConnectorProvider,
} from "./connector-provider.js";
import {
  cacheConnectorEventResult,
  currentConnectorEventAuthorization,
  decryptConnectorReplyTarget,
  encryptConnectorReplyTarget,
  finishConnectorEvent,
  finishConnectorJob,
  listEnabledDingTalkConnectorIds,
  loadConnectorConfig,
  nextConnectorEvents,
  nextConnectorJobs,
  recordConnectorEvent,
  redactConnectorErrorMessage,
  renewConnectorEventLease,
  saveConnectorMessageLink,
  setConnectorRuntimeState,
  type ConnectorEventRow,
  type ConnectorEventAuthorizationSnapshot,
  type ConnectorJobRow,
} from "./connector-service.js";
import { sendWeComAppText } from "./wecom-callback.js";

const wecomWebhookDriver: ConnectorProviderDriver = {
  provider: "WECOM_WEBHOOK",
  async deliver(config, job) {
    const response = await fetchWithTimeout(config.webhookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: String(job.payload.text ?? job.payload.summary ?? "NearChat 提醒") },
      }),
    });
    const body = await readJsonResponse(response);
    if (body.errcode !== 0)
      throw new Error(String(body.errmsg ?? `企业微信 Webhook 错误 ${body.errcode}`));
  },
};

function deliveryTarget(job: ConnectorDelivery): string {
  const encrypted = job.payload.encryptedDeliveryTarget;
  if (typeof encrypted !== "string" || !encrypted) throw new Error("投递任务缺少加密的外部目标");
  return decryptConnectorReplyTarget(encrypted);
}

function validDingTalkSessionTarget(payload: Record<string, unknown>): string | null {
  const expiresAt = payload.deliveryTargetExpiresAt;
  if (typeof expiresAt !== "string") return null;
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    return null;
  }
  const encrypted = payload.encryptedDeliveryTarget;
  if (typeof encrypted !== "string" || !encrypted) return null;
  try {
    const target = decryptConnectorReplyTarget(encrypted);
    validateDingTalkSessionWebhook(target);
    return target;
  } catch {
    return null;
  }
}

/** 有效 sessionWebhook 优先；缺失、损坏或过期时使用 CALLBACK 证明的企业机器人路由。 */
export async function deliverDingTalkText(
  config: ConnectorConfigPayload,
  payload: Record<string, unknown>,
  text: string,
  options: DingTalkOpenApiOptions = {},
): Promise<{ externalMessageId?: string }> {
  const sessionTarget = validDingTalkSessionTarget(payload);
  if (sessionTarget) {
    try {
      await sendDingTalkSessionReply(sessionTarget, text, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      return {};
    } catch (error) {
      // 只有平台明确声明 session 失效/未授权时才能安全换路由；超时和网络异常
      // 可能已经完成外发，贸然 fallback 会制造重复消息。
      if (!(error instanceof DingTalkSessionUnavailableError)) throw error;
    }
  }
  return sendDingTalkOpenApiText(
    config,
    parseDingTalkDeliveryRoute(payload.dingTalkRoute),
    text,
    options,
  );
}

const dingtalkDriver: ConnectorProviderDriver = {
  provider: "DINGTALK_STREAM",
  async deliver(config, job) {
    return deliverDingTalkText(
      config,
      job.payload,
      String(job.payload.text ?? job.payload.summary ?? "NearChat 提醒"),
    );
  },
};

const wecomCallbackDriver: ConnectorProviderDriver = {
  provider: "WECOM_CALLBACK",
  async deliver(config, job) {
    return sendWeComAppText(
      config,
      deliveryTarget(job),
      String(job.payload.text ?? job.payload.summary ?? "NearChat 提醒"),
    );
  },
};

const drivers = new Map(
  [wecomWebhookDriver, dingtalkDriver, wecomCallbackDriver].map((driver) => [
    driver.provider,
    driver,
  ]),
);

export interface ConnectorWorkerDependencies {
  nextJobs(): Promise<ConnectorJobRow[]>;
  nextEvents(): Promise<ConnectorEventRow[]>;
  deliverJob(job: ConnectorJobRow): Promise<void>;
  processEvent(event: ConnectorEventRow): Promise<void>;
  finishJob(id: string, error?: unknown): Promise<void>;
  finishEvent(id: string, result: Record<string, unknown>, error?: unknown): Promise<void>;
  logError(message: string, error: unknown): void;
}

export interface ConnectorJobDeliveryDependencies {
  loadConfig(connectorId: string): Promise<{
    config: { provider: ConnectorProvider };
    payload: ConnectorConfigPayload;
  }>;
  driver(provider: ConnectorProvider): ConnectorProviderDriver | undefined;
  saveMessageLink(input: Parameters<typeof saveConnectorMessageLink>[0]): Promise<void>;
}

const defaultConnectorJobDeliveryDependencies: ConnectorJobDeliveryDependencies = {
  loadConfig: (connectorId) => loadConnectorConfig(connectorId),
  driver: (provider) => drivers.get(provider),
  saveMessageLink: saveConnectorMessageLink,
};

export async function deliverConnectorJob(
  job: ConnectorJobRow,
  dependencies: ConnectorJobDeliveryDependencies = defaultConnectorJobDeliveryDependencies,
): Promise<void> {
  const { config, payload } = await dependencies.loadConfig(job.connector_id);
  const driver = dependencies.driver(config.provider);
  if (!driver) throw new Error(`连接器 ${config.provider} 不支持主动投递`);
  const result = await driver.deliver(payload, {
    id: job.id,
    connectorId: job.connector_id,
    kind: job.kind,
    payload: job.payload,
  });
  if (result?.externalMessageId) {
    await dependencies.saveMessageLink({
      connectorId: job.connector_id,
      externalMessageId: result.externalMessageId,
      direction: "OUTBOUND",
      deliveryJobId: job.id,
    });
  }
}

export interface PreparedInboundResult {
  prepared: true;
  disposition: "REPLIED" | "UNBOUND";
  replyText?: string;
  encryptedReplyTarget?: string;
  replyTargetExpiresAt?: string;
  dingTalkRoute?: DingTalkDeliveryRoute;
  nearChatMessageId?: string;
  metadata?: Record<string, unknown>;
  authorization?: ConnectorEventAuthorizationSnapshot;
}

function parseAuthorizationSnapshot(value: unknown): ConnectorEventAuthorizationSnapshot | null {
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

function sameAuthorization(
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

function cachedInboundResult(value: Record<string, unknown>): PreparedInboundResult | null {
  if (value.prepared !== true) return null;
  if (value.disposition !== "REPLIED" && value.disposition !== "UNBOUND") return null;
  const authorization = parseAuthorizationSnapshot(value.authorization);
  // 旧版本缓存没有授权快照，不能在重绑/解绑后直接外发；重新 prepare 会复用
  // connector_event_id 唯一消息，既 fail closed 也不重复生成助理副作用。
  if (value.disposition === "REPLIED" && !authorization) return null;
  return {
    prepared: true,
    disposition: value.disposition,
    replyText: typeof value.replyText === "string" ? value.replyText : undefined,
    encryptedReplyTarget:
      typeof value.encryptedReplyTarget === "string" ? value.encryptedReplyTarget : undefined,
    replyTargetExpiresAt:
      typeof value.replyTargetExpiresAt === "string" ? value.replyTargetExpiresAt : undefined,
    dingTalkRoute:
      value.dingTalkRoute &&
      typeof value.dingTalkRoute === "object" &&
      !Array.isArray(value.dingTalkRoute)
        ? parseDingTalkDeliveryRoute(value.dingTalkRoute)
        : undefined,
    nearChatMessageId:
      typeof value.nearChatMessageId === "string" ? value.nearChatMessageId : undefined,
    metadata:
      value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? (value.metadata as Record<string, unknown>)
        : undefined,
    authorization: authorization ?? undefined,
  };
}

export interface ClaimedConnectorEventDependencies {
  prepare(event: ConnectorEventRow): Promise<ProcessedConnectorEvent>;
  cache(id: string, result: PreparedInboundResult): Promise<void>;
  deliver(event: ConnectorEventRow, result: PreparedInboundResult): Promise<void>;
  finish(id: string, result: Record<string, unknown>): Promise<void>;
  renew?(id: string): Promise<void>;
}

async function deliverPreparedInbound(
  event: ConnectorEventRow,
  result: PreparedInboundResult,
): Promise<void> {
  if (result.disposition === "REPLIED") {
    if (!result.replyText) throw new Error("连接器回复缺少文本");
    if (!result.authorization) throw new Error("连接器回复缺少授权快照");
    const authorization = await currentConnectorEventAuthorization(
      event.connector_id,
      event.external_conversation_id,
      event.external_user_id,
    );
    if (!sameAuthorization(result.authorization, authorization)) {
      throw new Error("连接器回复授权已变更，已拒绝外发缓存回复");
    }
    const { config, payload } = await loadConnectorConfig(event.connector_id);
    let externalMessageId: string | undefined;
    if (config.provider === "DINGTALK_STREAM") {
      const delivered = await deliverDingTalkText(
        payload,
        {
          encryptedDeliveryTarget: result.encryptedReplyTarget,
          deliveryTargetExpiresAt: result.replyTargetExpiresAt,
          dingTalkRoute: result.dingTalkRoute,
        },
        result.replyText,
      );
      externalMessageId = delivered.externalMessageId;
    } else if (config.provider === "WECOM_CALLBACK") {
      if (!result.encryptedReplyTarget) throw new Error("连接器回复缺少外部目标");
      const delivered = await sendWeComAppText(
        payload,
        decryptConnectorReplyTarget(result.encryptedReplyTarget),
        result.replyText,
      );
      externalMessageId = delivered.externalMessageId;
    } else {
      throw new Error(`连接器 ${config.provider} 不支持入站回复`);
    }
    await saveConnectorMessageLink({
      connectorId: event.connector_id,
      externalMessageId: externalMessageId ?? `reply:${event.external_event_id}`,
      direction: "OUTBOUND",
      eventId: event.id,
      nearChatMessageId: result.nearChatMessageId,
    });
  }
}

const claimedEventDependencies: ClaimedConnectorEventDependencies = {
  async prepare(event) {
    const result = await processConnectorInboundEvent(event);
    return result;
  },
  cache: (id, result) => cacheConnectorEventResult(id, { ...result }),
  deliver: deliverPreparedInbound,
  finish: (id, result) => finishConnectorEvent(id, result),
  renew: renewConnectorEventLease,
};

/** 模型结果先落库；外发失败后的重试直接复用缓存，不会再次写入助理消息。 */
export async function processClaimedConnectorEvent(
  event: ConnectorEventRow,
  dependencies: ClaimedConnectorEventDependencies = claimedEventDependencies,
): Promise<void> {
  let renewing = false;
  const timer = dependencies.renew
    ? setInterval(() => {
        if (renewing) return;
        renewing = true;
        void dependencies.renew!(event.id)
          .catch((error) =>
            console.error(`Connector event ${event.id} lease renewal failed:`, error),
          )
          .finally(() => {
            renewing = false;
          });
      }, 30_000)
    : null;
  timer?.unref();
  try {
    let prepared = cachedInboundResult(event.result);
    if (!prepared) {
      const draft = await dependencies.prepare(event);
      const generated: PreparedInboundResult = { prepared: true, ...draft };
      await dependencies.cache(event.id, generated);
      prepared = generated;
    }
    await dependencies.deliver(event, prepared);
    await dependencies.finish(event.id, { ...prepared });
  } finally {
    if (timer) clearInterval(timer);
  }
}

const defaultWorkerDependencies: ConnectorWorkerDependencies = {
  nextJobs: () => nextConnectorJobs(),
  nextEvents: () => nextConnectorEvents(),
  deliverJob: deliverConnectorJob,
  processEvent: processClaimedConnectorEvent,
  finishJob: finishConnectorJob,
  finishEvent: finishConnectorEvent,
  logError(message, error) {
    console.error(message, redactConnectorErrorMessage(error));
  },
};

/** 单个任务/事件失败不会中断同批其他项目，状态回写失败也只记录而不形成未处理拒绝。 */
export async function runConnectorWorkerCycle(
  dependencies: ConnectorWorkerDependencies = defaultWorkerDependencies,
): Promise<void> {
  const processEvents = async () => {
    let events: ConnectorEventRow[] = [];
    try {
      events = await dependencies.nextEvents();
    } catch (error) {
      dependencies.logError("Connector event claim failed:", error);
    }
    for (const event of events) {
      try {
        await dependencies.processEvent(event);
      } catch (error) {
        try {
          await dependencies.finishEvent(event.id, {}, error);
        } catch (finishError) {
          dependencies.logError(`Connector event ${event.id} status update failed:`, finishError);
        }
      }
    }
  };

  const processJobs = async () => {
    let jobs: ConnectorJobRow[] = [];
    try {
      jobs = await dependencies.nextJobs();
    } catch (error) {
      dependencies.logError("Connector delivery claim failed:", error);
    }
    for (const job of jobs) {
      try {
        await dependencies.deliverJob(job);
        await dependencies.finishJob(job.id);
      } catch (error) {
        try {
          await dependencies.finishJob(job.id, error);
        } catch (finishError) {
          dependencies.logError(`Connector delivery ${job.id} status update failed:`, finishError);
        }
      }
    }
  };

  // AI 入站处理和主动提醒投递使用独立批次，慢模型不能阻塞外部提醒。
  await Promise.all([processEvents(), processJobs()]);
}

export function startConnectorWorker(): () => void {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runConnectorWorkerCycle();
    } catch (error) {
      // 最后一层隔离保证未来扩展的 cycle 逻辑也不会把连接器故障升级为进程故障。
      console.error("Connector worker cycle failed:", error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, 2_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface DingTalkCallbackDependencies {
  persist(
    input: Parameters<typeof recordConnectorEvent>[0],
  ): Promise<{ id: string | null; created: boolean; status: string }>;
  acknowledge(messageId: string): void;
}

/** ACK 严格发生在事件事务提交之后；持久化失败时不 ACK，让钉钉按协议重试。 */
export async function handleDingTalkRobotCallback(
  connectorId: string,
  event: DWClientDownStream,
  dependencies: DingTalkCallbackDependencies,
): Promise<void> {
  const parsed = parseDingTalkRobotText(connectorId, event);
  if (parsed) {
    await dependencies.persist({
      connectorId,
      message: parsed.message,
      encryptedReplyTarget: encryptConnectorReplyTarget(parsed.sessionWebhook),
      replyTargetExpiresAt: parsed.sessionWebhookExpiresAt,
      dingTalkRoute: parsed.deliveryRoute,
    });
  }
  dependencies.acknowledge(event.headers.messageId);
}

const dingTalkStreams = new Map<string, () => void>();

export interface DingTalkStreamClient {
  connected: boolean;
  registered: boolean;
  registerCallbackListener(topic: string, callback: (event: DWClientDownStream) => void): void;
  connect(): Promise<void>;
  disconnect(): void;
  socketCallBackResponse(messageId: string, result: Record<string, unknown>): void;
}

export interface DingTalkStreamStartDependencies {
  loadConfig(connectorId: string): Promise<{
    config: { provider: string };
    payload: { clientId?: string; clientSecret?: string };
  }>;
  createClient(options: { clientId: string; clientSecret: string }): DingTalkStreamClient;
  persist: DingTalkCallbackDependencies["persist"];
  connectionTimeoutMs?: number;
  registrationTimeoutMs?: number;
}

const defaultDingTalkStreamStartDependencies: DingTalkStreamStartDependencies = {
  loadConfig: (connectorId) => loadConnectorConfig(connectorId),
  createClient: (options) => new DWClient(options),
  persist: recordConnectorEvent,
  connectionTimeoutMs: 10_000,
  registrationTimeoutMs: 10_000,
};

async function connectDingTalkWithTimeout(
  client: DingTalkStreamClient,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("钉钉 Stream 首次连接超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForDingTalkRegistration(
  client: DingTalkStreamClient,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (client.connected && !client.registered && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, timeoutMs)));
  }
  return client.connected && client.registered;
}

/** 订阅机器人 CALLBACK，而不是只订阅普通 EVENT；文本事件持久化后才应答平台。 */
export async function startDingTalkStream(
  connectorId: string,
  dependencies: DingTalkStreamStartDependencies = defaultDingTalkStreamStartDependencies,
): Promise<() => void> {
  const { config, payload } = await dependencies.loadConfig(connectorId);
  if (config.provider !== "DINGTALK_STREAM") throw new Error("连接器不是钉钉 Stream");
  const client = dependencies.createClient({
    clientId: payload.clientId!,
    clientSecret: payload.clientSecret!,
  });
  client.registerCallbackListener(TOPIC_ROBOT, (event) => {
    void handleDingTalkRobotCallback(connectorId, event, {
      persist: dependencies.persist,
      acknowledge: (messageId) => client.socketCallBackResponse(messageId, {}),
    }).catch((error) =>
      console.error(
        `钉钉 Stream 连接器 ${connectorId} 事件处理失败：`,
        redactConnectorErrorMessage(error),
      ),
    );
  });
  try {
    await connectDingTalkWithTimeout(client, dependencies.connectionTimeoutMs ?? 10_000);
  } catch (error) {
    client.disconnect();
    throw error;
  }
  // 当前 SDK 会吞掉首连鉴权/网络异常并进入后台重连，因此必须核对真实 WebSocket open 状态。
  if (!client.connected) {
    client.disconnect();
    throw new Error("钉钉 Stream 首次连接未成功，连接器将保持非运行状态");
  }
  if (!(await waitForDingTalkRegistration(client, dependencies.registrationTimeoutMs ?? 10_000))) {
    client.disconnect();
    throw new Error("钉钉 Stream 订阅注册确认超时，连接器将保持非运行状态");
  }
  return () => client.disconnect();
}

export function stopConnectorRuntime(connectorId: string): void {
  dingTalkStreams.get(connectorId)?.();
  dingTalkStreams.delete(connectorId);
}

/** 创建、更新、启停后即时收敛运行态，不再要求重启整个 NearChat 服务。 */
export async function reconcileConnectorRuntime(
  connectorId: string,
): Promise<{ running: boolean; error: string | null }> {
  stopConnectorRuntime(connectorId);
  try {
    const { config } = await loadConnectorConfig(connectorId, false);
    if (!config.enabled) {
      await setConnectorRuntimeState(connectorId, { running: false });
      return { running: false, error: null };
    }
    if (config.provider === "DINGTALK_STREAM") {
      dingTalkStreams.set(connectorId, await startDingTalkStream(connectorId));
    }
    await setConnectorRuntimeState(connectorId, { running: true });
    return { running: true, error: null };
  } catch (error) {
    await setConnectorRuntimeState(connectorId, { running: false, error }).catch((stateError) =>
      console.error(`连接器 ${connectorId} 运行状态保存失败：`, stateError),
    );
    const message = redactConnectorErrorMessage(error, "连接器启动失败");
    return { running: false, error: message };
  }
}

export async function startConfiguredDingTalkStreams(): Promise<() => void> {
  for (const connectorId of await listEnabledDingTalkConnectorIds()) {
    const state = await reconcileConnectorRuntime(connectorId);
    if (state.error) console.error(`钉钉 Stream 连接器 ${connectorId} 启动失败：${state.error}`);
  }
  return () => {
    for (const connectorId of [...dingTalkStreams.keys()]) stopConnectorRuntime(connectorId);
  };
}
