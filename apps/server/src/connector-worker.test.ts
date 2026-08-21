import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorWorkerDependencies,
  DingTalkStreamClient,
  PreparedInboundResult,
} from "./connectors/connector-worker.js";
import {
  deliverConnectorJob,
  processClaimedConnectorEvent,
  runConnectorWorkerCycle,
  startDingTalkStream,
} from "./connectors/connector-worker.js";
import type { ConnectorProviderDriver } from "./connectors/connector-provider.js";
import type { ConnectorEventRow, ConnectorJobRow } from "./connectors/connector-service.js";

function event(id: string): ConnectorEventRow {
  return {
    id,
    connector_id: "00000000-0000-4000-8000-000000000001",
    provider: "DINGTALK_STREAM",
    external_event_id: `external-${id}`,
    external_conversation_id: `conversation-${id}`,
    external_user_id: `user-${id}`,
    event_kind: "TEXT",
    payload: {},
    result: {},
    attempts: 1,
  };
}

function job(id: string): ConnectorJobRow {
  return {
    id,
    connector_id: "00000000-0000-4000-8000-000000000001",
    kind: "TEXT",
    payload: {},
    attempts: 1,
    idempotency_key: `job-${id}`,
  };
}

test("连接器 worker 隔离单项错误并继续处理同批事件和投递", async () => {
  const calls: string[] = [];
  const dependencies: ConnectorWorkerDependencies = {
    async nextEvents() {
      return [event("event-1"), event("event-2")];
    },
    async nextJobs() {
      return [job("job-1"), job("job-2")];
    },
    async processEvent(item) {
      calls.push(`event:${item.id}`);
      if (item.id === "event-1") throw new Error("event failed");
    },
    async deliverJob(item) {
      calls.push(`job:${item.id}`);
      if (item.id === "job-1") throw new Error("job failed");
    },
    async finishEvent(id, _result, error) {
      calls.push(`finish-event:${id}:${error ? "failed" : "ok"}`);
    },
    async finishJob(id, error) {
      calls.push(`finish-job:${id}:${error ? "failed" : "ok"}`);
    },
    logError(message) {
      calls.push(`log:${message}`);
    },
  };

  await runConnectorWorkerCycle(dependencies);
  assert.ok(calls.indexOf("event:event-1") < calls.indexOf("finish-event:event-1:failed"));
  assert.ok(calls.indexOf("finish-event:event-1:failed") < calls.indexOf("event:event-2"));
  assert.ok(calls.indexOf("job:job-1") < calls.indexOf("finish-job:job-1:failed"));
  assert.ok(calls.indexOf("finish-job:job-1:failed") < calls.indexOf("job:job-2"));
  assert.ok(calls.includes("finish-job:job-2:ok"));
});

test("钉钉 OpenAPI 返回 processQueryKey 时 worker 建立出站消息关联", async () => {
  const links: Array<Record<string, unknown>> = [];
  const driver: ConnectorProviderDriver = {
    provider: "DINGTALK_STREAM",
    async deliver() {
      return { externalMessageId: "ding-process-query-key" };
    },
  };
  const delivery = job("ding-openapi-link");
  await deliverConnectorJob(delivery, {
    async loadConfig() {
      return {
        config: {
          id: delivery.connector_id,
          provider: "DINGTALK_STREAM",
          name: "测试钉钉",
          enabled: true,
          revision: 1,
          callbackUrl: null,
          hasClientId: true,
          hasClientSecret: true,
          hasWebhookUrl: false,
          hasCallbackToken: false,
          hasEncodingAesKey: false,
          hasCorpId: false,
          hasAgentId: false,
          runtime: { running: true, startedAt: null, error: null },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        payload: { clientId: "app", clientSecret: "secret" },
      };
    },
    driver(provider) {
      return provider === "DINGTALK_STREAM" ? driver : undefined;
    },
    async saveMessageLink(input) {
      links.push(input);
    },
  });
  assert.deepEqual(links, [
    {
      connectorId: delivery.connector_id,
      externalMessageId: "ding-process-query-key",
      direction: "OUTBOUND",
      deliveryJobId: delivery.id,
    },
  ]);
});

test("事件认领失败不会阻断投递，状态回写失败也被最后一层隔离", async () => {
  const calls: string[] = [];
  const dependencies: ConnectorWorkerDependencies = {
    async nextEvents() {
      throw new Error("event database unavailable");
    },
    async nextJobs() {
      return [job("job-1")];
    },
    async processEvent() {},
    async deliverJob(item) {
      calls.push(`deliver:${item.id}`);
      throw new Error("remote unavailable");
    },
    async finishEvent() {},
    async finishJob() {
      throw new Error("status database unavailable");
    },
    logError(message) {
      calls.push(`log:${message}`);
    },
  };

  await assert.doesNotReject(runConnectorWorkerCycle(dependencies));
  assert.ok(calls.includes("log:Connector event claim failed:"));
  assert.ok(calls.includes("deliver:job-1"));
  assert.ok(calls.some((call) => call.includes("status update failed")));
});

test("AI 已生成但外发失败后，事件重试复用缓存且只调用一次 handler", async () => {
  let prepareCalls = 0;
  let deliveryCalls = 0;
  let cached: Record<string, unknown> = {};
  const first = event("event-retry");
  const dependencies = {
    async prepare() {
      prepareCalls += 1;
      return {
        disposition: "REPLIED" as const,
        replyText: "已生成的唯一回复",
        encryptedReplyTarget: "encrypted-target",
        nearChatMessageId: "00000000-0000-4000-8000-000000000010",
        authorization: {
          bindingId: "00000000-0000-4000-8000-000000000020",
          bindingOwnerId: "00000000-0000-4000-8000-000000000021",
          bindingAssistantId: "00000000-0000-4000-8000-000000000022",
          bindingNearChatConversationId: null,
          identityId: "00000000-0000-4000-8000-000000000023",
          identityNearChatUserId: "00000000-0000-4000-8000-000000000021",
        },
      };
    },
    async cache(_id: string, result: PreparedInboundResult) {
      cached = { ...result };
    },
    async deliver() {
      deliveryCalls += 1;
      if (deliveryCalls === 1) throw new Error("external platform unavailable");
    },
    async finish() {},
  };

  await assert.rejects(
    processClaimedConnectorEvent(first, dependencies),
    /external platform unavailable/,
  );
  await processClaimedConnectorEvent({ ...first, result: cached }, dependencies);

  assert.equal(prepareCalls, 1);
  assert.equal(deliveryCalls, 2);
  assert.equal(cached.prepared, true);
  assert.equal(cached.replyText, "已生成的唯一回复");
});

test("钉钉 SDK 首连失败即使 connect resolve 也不会把运行态误报为成功", async () => {
  let disconnected = false;
  const client: DingTalkStreamClient = {
    connected: false,
    registered: false,
    registerCallbackListener() {},
    async connect() {},
    disconnect() {
      disconnected = true;
    },
    socketCallBackResponse() {},
  };

  await assert.rejects(
    startDingTalkStream("00000000-0000-4000-8000-000000000001", {
      async loadConfig() {
        return {
          config: { provider: "DINGTALK_STREAM" },
          payload: { clientId: "client-id", clientSecret: "client-secret" },
        };
      },
      createClient() {
        return client;
      },
      async persist() {
        return { id: "event-id", created: true, status: "RECEIVED" };
      },
    }),
    /首次连接未成功/,
  );
  assert.equal(disconnected, true);
});

test("钉钉 SDK 首连卡住时按有界超时退出且不会显示运行中", async () => {
  let disconnected = false;
  const client: DingTalkStreamClient = {
    connected: false,
    registered: false,
    registerCallbackListener() {},
    async connect() {
      await new Promise<never>(() => {});
    },
    disconnect() {
      disconnected = true;
    },
    socketCallBackResponse() {},
  };

  await assert.rejects(
    startDingTalkStream("00000000-0000-4000-8000-000000000001", {
      async loadConfig() {
        return {
          config: { provider: "DINGTALK_STREAM" },
          payload: { clientId: "client-id", clientSecret: "client-secret" },
        };
      },
      createClient() {
        return client;
      },
      async persist() {
        return { id: "event-id", created: true, status: "RECEIVED" };
      },
      connectionTimeoutMs: 1,
    }),
    /首次连接超时/,
  );
  assert.equal(disconnected, true);
});

test("钉钉 SDK WebSocket open 且订阅 REGISTERED 后才返回运行实例", async () => {
  let disconnected = false;
  const client: DingTalkStreamClient = {
    connected: true,
    registered: true,
    registerCallbackListener() {},
    async connect() {},
    disconnect() {
      disconnected = true;
    },
    socketCallBackResponse() {},
  };

  const stop = await startDingTalkStream("00000000-0000-4000-8000-000000000001", {
    async loadConfig() {
      return {
        config: { provider: "DINGTALK_STREAM" },
        payload: { clientId: "client-id", clientSecret: "client-secret" },
      };
    },
    createClient() {
      return client;
    },
    async persist() {
      return { id: "event-id", created: true, status: "RECEIVED" };
    },
  });

  assert.equal(disconnected, false);
  stop();
  assert.equal(disconnected, true);
});

test("钉钉 WebSocket 已打开但订阅未 REGISTERED 时不会显示运行中", async () => {
  let disconnected = false;
  const client: DingTalkStreamClient = {
    connected: true,
    registered: false,
    registerCallbackListener() {},
    async connect() {},
    disconnect() {
      disconnected = true;
      this.connected = false;
    },
    socketCallBackResponse() {},
  };

  await assert.rejects(
    startDingTalkStream("00000000-0000-4000-8000-000000000001", {
      async loadConfig() {
        return {
          config: { provider: "DINGTALK_STREAM" },
          payload: { clientId: "client-id", clientSecret: "client-secret" },
        };
      },
      createClient() {
        return client;
      },
      async persist() {
        return { id: "event-id", created: true, status: "RECEIVED" };
      },
      registrationTimeoutMs: 1,
    }),
    /订阅注册确认超时/,
  );
  assert.equal(disconnected, true);
});
