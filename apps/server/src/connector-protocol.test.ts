import assert from "node:assert/strict";
import test from "node:test";
import type { DWClientDownStream } from "dingtalk-stream";
import { normalizePublicBaseUrl } from "./config.js";
import { ApiError } from "./http.js";
import { externalAssistantPrompt } from "./connectors/connector-inbound.js";
import { processConnectorInboundEvent } from "./connectors/connector-inbound.js";
import {
  parseDingTalkRobotText,
  sendDingTalkOpenApiText,
} from "./connectors/dingtalk-connector.js";
import {
  connectorCallbackUrl,
  encryptConnectorReplyTarget,
  redactConnectorErrorMessage,
  validateConnectorConfig,
} from "./connectors/connector-service.js";
import { deliverDingTalkText, handleDingTalkRobotCallback } from "./connectors/connector-worker.js";
import {
  decryptWeComPayload,
  encryptWeComPayload,
  encryptedWeComEnvelope,
  parseWeComTextMessage,
  sendWeComAppText,
  verifyAndDecryptWeComCallback,
  weComSignature,
} from "./connectors/wecom-callback.js";

function dingTalkEvent(data: Record<string, unknown>): DWClientDownStream {
  return {
    specVersion: "1.0",
    type: "CALLBACK",
    headers: {
      appId: "app",
      connectionId: "connection",
      contentType: "application/json",
      messageId: "stream-message-1",
      time: "0",
      topic: "/v1.0/im/bot/messages/get",
    },
    data: JSON.stringify(data),
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function weComConfig(testId: string) {
  return {
    callbackToken: `callback-${testId}`,
    encodingAesKey: Buffer.alloc(32, 5).toString("base64").replace(/=$/, ""),
    corpId: `ww-${testId}`,
    agentId: "1000002",
    clientSecret: `secret-${testId}`,
  };
}

const dingTalkText = {
  conversationId: "cid-group-1",
  chatbotCorpId: "corp",
  chatbotUserId: "bot",
  msgId: "ding-msg-1",
  senderNick: "外部用户",
  isAdmin: false,
  senderStaffId: "staff-1",
  sessionWebhookExpiredTime: Date.now() + 60_000,
  createAt: Date.parse("2026-08-21T01:00:00.000Z"),
  senderCorpId: "corp",
  conversationType: "2",
  senderId: "sender-1",
  sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=secret",
  robotCode: "robot",
  msgtype: "text",
  text: { content: "  汇总今天的项目进展  " },
};

test("钉钉机器人 CALLBACK 使用业务 msgId 并规范化文本上下文", () => {
  const parsed = parseDingTalkRobotText(
    "00000000-0000-4000-8000-000000000001",
    dingTalkEvent(dingTalkText),
  );
  assert.ok(parsed);
  assert.equal(parsed.message.externalEventId, "ding-msg-1");
  assert.equal(parsed.message.externalConversationId, "cid-group-1");
  assert.equal(parsed.message.externalUserId, "staff-1");
  assert.equal(parsed.message.text, "汇总今天的项目进展");
  assert.equal(
    parsed.sessionWebhookExpiresAt,
    new Date(dingTalkText.sessionWebhookExpiredTime).toISOString(),
  );
  assert.deepEqual(parsed.deliveryRoute, {
    conversationType: "2",
    robotCode: "robot",
    senderStaffId: "staff-1",
    openConversationId: "cid-group-1",
  });
  assert.match(externalAssistantPrompt(parsed.message), /不可信用户输入/);
  assert.match(externalAssistantPrompt(parsed.message), /JSON 字符串编码/);
});

test("钉钉会话 Webhook 失效时间持久化且过期事件不会进入助理模型", async () => {
  assert.throws(
    () =>
      parseDingTalkRobotText(
        "00000000-0000-4000-8000-000000000001",
        dingTalkEvent({ ...dingTalkText, sessionWebhookExpiredTime: undefined }),
      ),
    /sessionWebhookExpiredTime/,
  );
  const parsed = parseDingTalkRobotText(
    "00000000-0000-4000-8000-000000000001",
    dingTalkEvent({ ...dingTalkText, sessionWebhookExpiredTime: Date.now() - 1_000 }),
  )!;
  await assert.rejects(
    processConnectorInboundEvent({
      id: "00000000-0000-4000-8000-000000000099",
      connector_id: parsed.message.connectorId,
      provider: "DINGTALK_STREAM",
      external_event_id: parsed.message.externalEventId,
      external_conversation_id: parsed.message.externalConversationId,
      external_user_id: parsed.message.externalUserId,
      event_kind: "TEXT",
      payload: {
        message: parsed.message,
        encryptedReplyTarget: "encrypted",
        replyTargetExpiresAt: parsed.sessionWebhookExpiresAt,
      },
      result: {},
      attempts: 1,
    }),
    /既无有效会话 Webhook，也无可用的企业机器人主动投递路由/,
  );
});

test("钉钉 OpenAPI 群聊和私聊使用严格路由且复用访问令牌", async () => {
  const requests: Array<{
    url: string;
    body: Record<string, unknown>;
    accessToken: string | null;
  }> = [];
  let tokenRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      url,
      body,
      accessToken: new Headers(init?.headers).get("x-acs-dingtalk-access-token"),
    });
    if (url.endsWith("/oauth2/accessToken")) {
      tokenRequests += 1;
      return jsonResponse({ accessToken: "cached-openapi-token", expireIn: 7200 });
    }
    return jsonResponse({
      processQueryKey: url.includes("groupMessages") ? "group-query-key" : "private-query-key",
    });
  }) as typeof fetch;
  const config = { clientId: "openapi-cache-app", clientSecret: "openapi-cache-secret" };

  const group = await sendDingTalkOpenApiText(
    config,
    {
      conversationType: "2",
      robotCode: "robot-code",
      senderStaffId: "staff-1",
      openConversationId: "cid-group-1",
    },
    "群聊提醒",
    { fetchImpl },
  );
  const direct = await sendDingTalkOpenApiText(
    config,
    { conversationType: "1", robotCode: "robot-code", senderStaffId: "staff-2" },
    "私聊提醒",
    { fetchImpl },
  );

  assert.equal(tokenRequests, 1);
  assert.equal(group.externalMessageId, "group-query-key");
  assert.equal(direct.externalMessageId, "private-query-key");
  const groupRequest = requests.find((request) => request.url.includes("groupMessages"))!;
  assert.deepEqual(groupRequest.body, {
    robotCode: "robot-code",
    openConversationId: "cid-group-1",
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: "群聊提醒" }),
  });
  assert.equal(groupRequest.accessToken, "cached-openapi-token");
  const directRequest = requests.find((request) => request.url.includes("oToMessages"))!;
  assert.deepEqual(directRequest.body, {
    robotCode: "robot-code",
    userIds: ["staff-2"],
    msgKey: "sampleText",
    msgParam: JSON.stringify({ content: "私聊提醒" }),
  });
  assert.equal(directRequest.accessToken, "cached-openapi-token");
});

test("钉钉 OpenAPI 在令牌进入提前刷新窗口后重新获取", async () => {
  let now = 1_000_000;
  let tokenRequests = 0;
  const sentTokens: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/accessToken")) {
      tokenRequests += 1;
      return jsonResponse({ accessToken: `refresh-token-${tokenRequests}`, expireIn: 120 });
    }
    sentTokens.push(new Headers(init?.headers).get("x-acs-dingtalk-access-token") ?? "");
    return jsonResponse({});
  }) as typeof fetch;
  const config = { clientId: "refresh-ahead-app", clientSecret: "refresh-ahead-secret" };
  const route = { conversationType: "1" as const, robotCode: "robot", senderStaffId: "staff" };
  await sendDingTalkOpenApiText(config, route, "第一次", { fetchImpl, now: () => now });
  now += 60_001;
  await sendDingTalkOpenApiText(config, route, "第二次", { fetchImpl, now: () => now });
  assert.equal(tokenRequests, 2);
  assert.deepEqual(sentTokens, ["refresh-token-1", "refresh-token-2"]);
});

test("钉钉 OpenAPI 遇认证 code 时失效旧令牌并仅刷新重试一次", async () => {
  let tokenRequests = 0;
  let sendRequests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth2/accessToken")) {
      tokenRequests += 1;
      return jsonResponse({ accessToken: `auth-code-token-${tokenRequests}`, expireIn: 7200 });
    }
    sendRequests += 1;
    return jsonResponse({ code: "InvalidAccessToken" });
  }) as typeof fetch;

  await assert.rejects(
    sendDingTalkOpenApiText(
      { clientId: "auth-code-app", clientSecret: "auth-code-secret" },
      { conversationType: "1", robotCode: "robot", senderStaffId: "staff" },
      "认证失败",
      { fetchImpl },
    ),
    /InvalidAccessToken/,
  );
  await assert.rejects(
    sendDingTalkOpenApiText(
      { clientId: "auth-code-app", clientSecret: "auth-code-secret" },
      { conversationType: "1", robotCode: "robot", senderStaffId: "staff" },
      "下一次任务不能复用已知坏令牌",
      { fetchImpl },
    ),
    /InvalidAccessToken/,
  );
  assert.equal(tokenRequests, 4);
  assert.equal(sendRequests, 4);
});

test("钉钉 OpenAPI 遇 HTTP 401 后刷新令牌并成功投递", async () => {
  let tokenRequests = 0;
  let sendRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/accessToken")) {
      tokenRequests += 1;
      return jsonResponse({ accessToken: `http-token-${tokenRequests}`, expireIn: 7200 });
    }
    sendRequests += 1;
    const token = new Headers(init?.headers).get("x-acs-dingtalk-access-token");
    return token === "http-token-1"
      ? jsonResponse({ code: "Unauthorized" }, 401)
      : jsonResponse({ processQueryKey: "refreshed-query-key" });
  }) as typeof fetch;

  const result = await sendDingTalkOpenApiText(
    { clientId: "http-401-app", clientSecret: "http-401-secret" },
    { conversationType: "1", robotCode: "robot", senderStaffId: "staff" },
    "刷新成功",
    { fetchImpl },
  );
  assert.equal(result.externalMessageId, "refreshed-query-key");
  assert.equal(tokenRequests, 2);
  assert.equal(sendRequests, 2);
});

test("钉钉会话过期或明确 401 时 fallback 到 OpenAPI，无安全路由则失败", async () => {
  const route = {
    conversationType: "2" as const,
    robotCode: "fallback-robot",
    senderStaffId: "fallback-staff",
    openConversationId: "fallback-conversation",
  };
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("session=body-expired")) {
      return jsonResponse({ errcode: 400101, errmsg: "session expired" });
    }
    if (url.includes("sendBySession")) return jsonResponse({}, 401);
    if (url.endsWith("/oauth2/accessToken")) {
      return jsonResponse({ accessToken: "fallback-token", expireIn: 7200 });
    }
    return jsonResponse({ processQueryKey: `fallback-${calls.length}` });
  }) as typeof fetch;
  const config = { clientId: "fallback-app", clientSecret: "fallback-secret" };

  const expired = await deliverDingTalkText(
    config,
    {
      encryptedDeliveryTarget: "not-read-after-expiry",
      deliveryTargetExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      dingTalkRoute: route,
    },
    "过期会话主动补投",
    { fetchImpl },
  );
  assert.ok(expired.externalMessageId);
  assert.equal(
    calls.some((url) => url.includes("sendBySession")),
    false,
  );

  calls.length = 0;
  const session401 = await deliverDingTalkText(
    { clientId: "fallback-401-app", clientSecret: "fallback-401-secret" },
    {
      encryptedDeliveryTarget: encryptConnectorReplyTarget(
        "https://oapi.dingtalk.com/robot/sendBySession?session=expired-session",
      ),
      deliveryTargetExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      dingTalkRoute: route,
    },
    "会话明确失效后补投",
    { fetchImpl },
  );
  assert.ok(session401.externalMessageId);
  assert.equal(calls[0]!.includes("sendBySession"), true);
  assert.equal(
    calls.some((url) => url.includes("groupMessages")),
    true,
  );

  calls.length = 0;
  const bodyExpired = await deliverDingTalkText(
    { clientId: "fallback-body-app", clientSecret: "fallback-body-secret" },
    {
      encryptedDeliveryTarget: encryptConnectorReplyTarget(
        "https://oapi.dingtalk.com/robot/sendBySession?session=body-expired",
      ),
      deliveryTargetExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      dingTalkRoute: route,
    },
    "平台响应会话过期后补投",
    { fetchImpl },
  );
  assert.ok(bodyExpired.externalMessageId);
  assert.equal(
    calls.some((url) => url.includes("groupMessages")),
    true,
  );

  await assert.rejects(
    deliverDingTalkText(
      config,
      { deliveryTargetExpiresAt: new Date(Date.now() - 1_000).toISOString() },
      "没有路由",
      { fetchImpl },
    ),
    /缺少安全路由/,
  );
});

test("钉钉有效 session 的网络不确定错误不会切换 OpenAPI 造成重复投递", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error("socket closed after write");
  }) as typeof fetch;
  await assert.rejects(
    deliverDingTalkText(
      { clientId: "ambiguous-app", clientSecret: "ambiguous-secret" },
      {
        encryptedDeliveryTarget: encryptConnectorReplyTarget(
          "https://oapi.dingtalk.com/robot/sendBySession?session=ambiguous-session",
        ),
        deliveryTargetExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        dingTalkRoute: {
          conversationType: "1",
          robotCode: "robot",
          senderStaffId: "staff",
        },
      },
      "不要重复",
      { fetchImpl },
    ),
    /socket closed after write/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.includes("sendBySession"), true);
});

test("钉钉 ACK 严格发生在事件持久化之后，写库失败时不 ACK", async () => {
  const order: string[] = [];
  await handleDingTalkRobotCallback(
    "00000000-0000-4000-8000-000000000001",
    dingTalkEvent(dingTalkText),
    {
      async persist() {
        order.push("persist:start");
        await Promise.resolve();
        order.push("persist:commit");
        return { id: "event", created: true, status: "RECEIVED" };
      },
      acknowledge() {
        order.push("ack");
      },
    },
  );
  assert.deepEqual(order, ["persist:start", "persist:commit", "ack"]);

  let acknowledged = false;
  await assert.rejects(
    handleDingTalkRobotCallback(
      "00000000-0000-4000-8000-000000000001",
      dingTalkEvent(dingTalkText),
      {
        async persist() {
          throw new Error("database unavailable");
        },
        acknowledge() {
          acknowledged = true;
        },
      },
    ),
    /database unavailable/,
  );
  assert.equal(acknowledged, false);
});

test("企微回调执行 SHA1 验签、AES-CBC 解密、Corp ID 校验和 XML 解析", () => {
  const encodingAesKey = Buffer.alloc(32, 7).toString("base64").replace(/=$/, "");
  const config = {
    callbackToken: "callback-token",
    encodingAesKey,
    corpId: "ww-corp-id",
    agentId: "1000002",
    clientSecret: "application-secret",
  };
  const plaintext = [
    "<xml>",
    "<ToUserName><![CDATA[ww-corp-id]]></ToUserName>",
    "<FromUserName><![CDATA[zhangsan]]></FromUserName>",
    "<CreateTime>1787274000</CreateTime>",
    "<MsgType><![CDATA[text]]></MsgType>",
    "<Content><![CDATA[查询项目进度]]></Content>",
    "<MsgId>123456789</MsgId>",
    "<AgentID>1000002</AgentID>",
    "</xml>",
  ].join("");
  const encrypted = encryptWeComPayload(
    plaintext,
    encodingAesKey,
    config.corpId,
    Buffer.alloc(16, 3),
  );
  assert.equal(decryptWeComPayload(encrypted, encodingAesKey, config.corpId), plaintext);
  const timestamp = "1787274000";
  const nonce = "nonce-1";
  const signature = weComSignature(config.callbackToken, timestamp, nonce, encrypted);
  const decrypted = verifyAndDecryptWeComCallback({
    config,
    signature,
    timestamp,
    nonce,
    encrypted,
    nowSeconds: Number(timestamp),
  });
  const message = parseWeComTextMessage(
    "00000000-0000-4000-8000-000000000002",
    decrypted,
    config.agentId,
  );
  assert.equal(message?.externalUserId, "zhangsan");
  assert.equal(message?.text, "查询项目进度");
  assert.equal(
    encryptedWeComEnvelope(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`),
    encrypted,
  );
  assert.throws(
    () =>
      verifyAndDecryptWeComCallback({
        config,
        signature: "0".repeat(40),
        timestamp,
        nonce,
        encrypted,
        nowSeconds: Number(timestamp),
      }),
    /签名无效/,
  );
});

test("连接器配置拒绝不完整企微回调和非官方 Webhook 主机", () => {
  assert.throws(
    () =>
      validateConnectorConfig("WECOM_CALLBACK", {
        corpId: "ww",
        agentId: "1",
        callbackToken: "token",
        encodingAesKey: "a".repeat(43),
      }),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.throws(
    () =>
      validateConnectorConfig("WECOM_WEBHOOK", {
        webhookUrl: "https://127.0.0.1/internal",
      }),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test("企业微信回调地址只由规范化 HTTPS 公网基址生成", () => {
  const base = normalizePublicBaseUrl(" https://chat.example.test/near-chat/ ");
  assert.equal(base, "https://chat.example.test/near-chat");
  assert.equal(
    connectorCallbackUrl("WECOM_CALLBACK", "00000000-0000-4000-8000-000000000002", base),
    "https://chat.example.test/near-chat/api/connectors/wecom/00000000-0000-4000-8000-000000000002/callback",
  );
  assert.equal(
    connectorCallbackUrl("DINGTALK_STREAM", "00000000-0000-4000-8000-000000000002", base),
    null,
  );
  assert.throws(() => normalizePublicBaseUrl("http://chat.example.test"), /必须使用 HTTPS/);
  assert.throws(
    () => normalizePublicBaseUrl("https://user:password@chat.example.test?token=secret"),
    /不能包含凭据/,
  );
});

test("连接器错误在服务端边界隐藏 URL、查询参数和常见凭据", () => {
  const raw = [
    "GET https://gateway.example.test/send?access_token=URL_SECRET",
    "Authorization: Bearer BEARER_SECRET",
    "token=TOKEN_SECRET",
    "clientSecret: CLIENT_SECRET",
    '"encodingAesKey":"AES_SECRET"',
    "path?key=QUERY_SECRET",
  ].join("\n");
  const redacted = redactConnectorErrorMessage(raw);
  assert.doesNotMatch(
    redacted,
    /gateway\.example|URL_SECRET|BEARER_SECRET|TOKEN_SECRET|CLIENT_SECRET|AES_SECRET|QUERY_SECRET/,
  );
  assert.match(redacted, /\[REDACTED/);
});

test("企微应用消息启用平台内容去重以缩小提交确认窗口", async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return url.includes("/gettoken")
      ? new Response(JSON.stringify({ errcode: 0, access_token: "token", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "wecom-message-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  }) as typeof fetch;
  const sent = await sendWeComAppText(
    {
      callbackToken: "token",
      encodingAesKey: Buffer.alloc(32, 5).toString("base64").replace(/=$/, ""),
      corpId: "ww-dedup-test",
      agentId: "1000002",
      clientSecret: "unique-dedup-secret",
    },
    "zhangsan",
    "只发送一次",
    { fetchImpl },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.body?.enable_duplicate_check, 1);
  assert.equal(requests[1]!.body?.duplicate_check_interval, 1_800);
  assert.equal(sent.externalMessageId, "wecom-message-1");
});

test("企微应用消息拒绝 @all 广播目标且不会请求令牌", async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return jsonResponse({ errcode: 0 });
  }) as typeof fetch;

  await assert.rejects(
    sendWeComAppText(weComConfig("reject-all-target"), " @ALL ", "禁止广播", { fetchImpl }),
    /不能使用广播目标/,
  );
  assert.equal(requests, 0);
});

test("企微应用消息遇 HTTP 401 时只刷新一次令牌后成功", async () => {
  let tokenRequests = 0;
  let sendRequests = 0;
  const sentTokens: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      return jsonResponse({
        errcode: 0,
        access_token: `wecom-http-401-token-${tokenRequests}`,
        expires_in: 7_200,
      });
    }
    sendRequests += 1;
    sentTokens.push(url.searchParams.get("access_token") ?? "");
    return sendRequests === 1
      ? jsonResponse({ errcode: 40014, errmsg: "invalid token" }, 401)
      : jsonResponse({ errcode: 0, errmsg: "ok", msgid: "wecom-http-401-message" });
  }) as typeof fetch;

  const sent = await sendWeComAppText(weComConfig("http-401-refresh"), "zhangsan", "刷新后发送", {
    fetchImpl,
  });

  assert.equal(tokenRequests, 2);
  assert.equal(sendRequests, 2);
  assert.deepEqual(sentTokens, ["wecom-http-401-token-1", "wecom-http-401-token-2"]);
  assert.equal(sent.externalMessageId, "wecom-http-401-message");
});

test("企微应用消息遇 40014 或 42001 时分别只刷新一次令牌", async () => {
  for (const authCode of [40014, 42001]) {
    let tokenRequests = 0;
    let sendRequests = 0;
    const sentTokens: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/gettoken")) {
        tokenRequests += 1;
        return jsonResponse({
          errcode: 0,
          access_token: `wecom-code-${authCode}-token-${tokenRequests}`,
          expires_in: 7_200,
        });
      }
      sendRequests += 1;
      sentTokens.push(url.searchParams.get("access_token") ?? "");
      return sendRequests === 1
        ? jsonResponse({ errcode: authCode, errmsg: "expired token" })
        : jsonResponse({ errcode: 0, errmsg: "ok", msgid: `wecom-code-${authCode}-message` });
    }) as typeof fetch;

    const sent = await sendWeComAppText(
      weComConfig(`auth-code-${authCode}`),
      "lisi",
      `认证错误 ${authCode}`,
      { fetchImpl },
    );

    assert.equal(tokenRequests, 2, `errcode ${authCode} 应只获取两次令牌`);
    assert.equal(sendRequests, 2, `errcode ${authCode} 应只投递两次`);
    assert.deepEqual(sentTokens, [
      `wecom-code-${authCode}-token-1`,
      `wecom-code-${authCode}-token-2`,
    ]);
    assert.equal(sent.externalMessageId, `wecom-code-${authCode}-message`);
  }
});

test("企微并发请求中迟到的旧令牌失败不会误删已刷新的新令牌", { timeout: 2_000 }, async () => {
  let tokenRequests = 0;
  let oldTokenSends = 0;
  let newTokenSends = 0;
  let releaseFirstOldFailure!: (response: Response) => void;
  let releaseLateOldFailure!: (response: Response) => void;
  const firstOldFailure = new Promise<Response>((resolve) => {
    releaseFirstOldFailure = resolve;
  });
  const lateOldFailure = new Promise<Response>((resolve) => {
    releaseLateOldFailure = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      return jsonResponse({
        errcode: 0,
        access_token: tokenRequests === 1 ? "wecom-race-old-token" : "wecom-race-new-token",
        expires_in: 7_200,
      });
    }
    const token = url.searchParams.get("access_token");
    if (token === "wecom-race-old-token") {
      oldTokenSends += 1;
      if (oldTokenSends === 2) {
        releaseFirstOldFailure(jsonResponse({ errcode: 40014, errmsg: "old token" }));
        return lateOldFailure;
      }
      return firstOldFailure;
    }
    assert.equal(token, "wecom-race-new-token");
    newTokenSends += 1;
    if (newTokenSends === 1) {
      releaseLateOldFailure(jsonResponse({ errcode: 40014, errmsg: "late old token" }));
    }
    return jsonResponse({ errcode: 0, errmsg: "ok", msgid: `wecom-race-${newTokenSends}` });
  }) as typeof fetch;

  const config = weComConfig("late-old-token-race");
  const [first, second] = await Promise.all([
    sendWeComAppText(config, "wangwu", "并发一", { fetchImpl }),
    sendWeComAppText(config, "zhaoliu", "并发二", { fetchImpl }),
  ]);

  assert.equal(tokenRequests, 2);
  assert.equal(oldTokenSends, 2);
  assert.equal(newTokenSends, 2);
  assert.deepEqual([first.externalMessageId, second.externalMessageId].sort(), [
    "wecom-race-1",
    "wecom-race-2",
  ]);
});

test("企微应用消息第二次认证失败会清缓存并让下一次调用重新获取令牌", async () => {
  let tokenRequests = 0;
  let sendRequests = 0;
  const sentTokens: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      return jsonResponse({
        errcode: 0,
        access_token: `wecom-double-failure-token-${tokenRequests}`,
        expires_in: 7_200,
      });
    }
    sendRequests += 1;
    sentTokens.push(url.searchParams.get("access_token") ?? "");
    if (sendRequests === 1) return jsonResponse({ errcode: 40014, errmsg: "invalid token" });
    if (sendRequests === 2) return jsonResponse({ errcode: 42001, errmsg: "expired token" });
    return jsonResponse({ errcode: 0, errmsg: "ok", msgid: "wecom-after-clear-message" });
  }) as typeof fetch;
  const config = weComConfig("double-auth-failure-clear");

  await assert.rejects(
    sendWeComAppText(config, "sunqi", "第一次应失败", { fetchImpl }),
    /expired token/,
  );
  const sent = await sendWeComAppText(config, "sunqi", "下一次重新获取令牌", { fetchImpl });

  assert.equal(tokenRequests, 3);
  assert.equal(sendRequests, 3);
  assert.deepEqual(sentTokens, [
    "wecom-double-failure-token-1",
    "wecom-double-failure-token-2",
    "wecom-double-failure-token-3",
  ]);
  assert.equal(sent.externalMessageId, "wecom-after-clear-message");
});
