import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api";
import type {
  AdminUser,
  ConnectorBinding,
  ConnectorConfig,
  ConnectorIdentity,
  ConnectorOperationEvent,
  ConnectorOperationsHealth,
} from "../types";
import { ConnectorSettingsPanel } from "./ConnectorSettingsPanel";

const admin: AdminUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "admin",
  displayName: "管理员",
  avatarColor: "#6655dd",
  avatarUrl: null,
  role: "ADMIN",
  enabled: true,
  online: true,
};

const member: AdminUser = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "xiaobei",
  displayName: "陈小北",
  avatarColor: "#228866",
  avatarUrl: null,
  role: "USER",
  enabled: true,
  online: false,
};

function connector(provider: ConnectorConfig["provider"] = "WECOM_CALLBACK"): ConnectorConfig {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    provider,
    name: provider === "WECOM_CALLBACK" ? "企业微信助理" : "研发群机器人",
    enabled: true,
    revision: 4,
    callbackUrl:
      provider === "WECOM_CALLBACK"
        ? "https://chat.example.test/api/connectors/wecom/33333333-3333-4333-8333-333333333333/callback"
        : null,
    hasClientId: provider === "DINGTALK_STREAM",
    hasClientSecret: provider !== "WECOM_WEBHOOK",
    hasWebhookUrl: provider === "WECOM_WEBHOOK",
    hasCallbackToken: provider === "WECOM_CALLBACK",
    hasEncodingAesKey: provider === "WECOM_CALLBACK",
    hasCorpId: provider === "WECOM_CALLBACK",
    hasAgentId: provider === "WECOM_CALLBACK",
    runtime: {
      running: true,
      startedAt: "2026-08-21T08:00:00.000Z",
      error: null,
    },
    createdAt: "2026-08-21T07:00:00.000Z",
    updatedAt: "2026-08-21T08:00:00.000Z",
  };
}

function mockLoads(
  connectors: ConnectorConfig[],
  identities: ConnectorIdentity[] = [],
  bindings: ConnectorBinding[] = [],
) {
  const list = vi.spyOn(api, "adminConnectors").mockResolvedValue({ connectors });
  vi.spyOn(api, "connectorIdentities").mockResolvedValue({ identities });
  vi.spyOn(api, "connectorBindings").mockResolvedValue({ bindings });
  vi.spyOn(api, "aiAssistants").mockResolvedValue({ assistants: [] });
  vi.spyOn(api, "conversations").mockResolvedValue({ conversations: [] });
  return list;
}

describe("ConnectorSettingsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("从空状态创建钉钉连接器且只把本次输入的密钥发送到服务端", async () => {
    const user = userEvent.setup();
    mockLoads([]);
    const created = connector("DINGTALK_STREAM");
    const create = vi.spyOn(api, "createAdminConnector").mockResolvedValue({
      connector: created,
      runtime: { running: true, error: null },
    });

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={vi.fn()} />,
    );

    await user.click(await screen.findByRole("button", { name: "新建连接器" }));
    await user.type(screen.getByLabelText("连接器名称"), "研发群机器人");
    await user.type(screen.getByLabelText("Client ID"), "ding-client-id");
    await user.type(screen.getByLabelText("Client Secret"), "ding-client-secret");
    await user.click(screen.getByRole("checkbox", { name: /保存后立即启用/ }));
    await user.click(screen.getByRole("button", { name: "保存连接器" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        provider: "DINGTALK_STREAM",
        name: "研发群机器人",
        enabled: true,
        config: {
          clientId: "ding-client-id",
          clientSecret: "ding-client-secret",
        },
      }),
    );
    expect(await screen.findByText("Stream 进程已启动（断线自动重连）")).toBeTruthy();
    expect(
      screen.getByText("停用连接器会取消待处理队列；已 RUNNING 的投递可能已完成。"),
    ).toBeTruthy();
  });

  it("展示企业微信回调地址并完成外部身份与助理会话绑定", async () => {
    const user = userEvent.setup();
    const target = connector();
    const identity: ConnectorIdentity = {
      id: "44444444-4444-4444-8444-444444444444",
      connectorId: target.id,
      externalUserId: "zhangsan",
      nearChatUserId: null,
      displayName: "张三",
      metadata: {},
    };
    mockLoads([target], [identity]);
    const map = vi.spyOn(api, "mapConnectorIdentity").mockResolvedValue({
      identity: { ...identity, nearChatUserId: member.id },
    });
    const savedBinding: ConnectorBinding = {
      id: "55555555-5555-4555-8555-555555555555",
      connectorId: target.id,
      ownerId: member.id,
      externalConversationId: "wecom-conversation-1",
      nearChatConversationId: null,
      assistantId: "66666666-6666-4666-8666-666666666666",
      deliveryKinds: ["REMINDER"],
      hasDeliveryTarget: true,
      hasDingTalkOpenApiRoute: false,
      deliveryTargetExpiresAt: null,
      enabled: true,
      metadata: {},
    };
    const save = vi.spyOn(api, "saveConnectorBinding").mockResolvedValue({
      binding: savedBinding,
    });

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={vi.fn()} />,
    );

    expect(
      await screen.findByText(new RegExp(`/api/connectors/wecom/${target.id}/callback$`)),
    ).toBeTruthy();
    expect(screen.getByText("已启用，等待公网回调验收")).toBeTruthy();
    await user.selectOptions(await screen.findByLabelText("映射 张三"), member.id);
    await waitFor(() =>
      expect(map).toHaveBeenCalledWith(target.id, identity.externalUserId, member.id),
    );

    await user.click(screen.getByRole("button", { name: "添加绑定" }));
    await user.selectOptions(screen.getByLabelText("绑定用户"), member.id);
    await user.type(screen.getByLabelText("外部会话 ID"), "wecom-conversation-1");
    await user.type(screen.getByLabelText(/个人助理 ID/), "66666666-6666-4666-8666-666666666666");
    await user.click(screen.getByRole("checkbox", { name: "提醒" }));
    await user.type(screen.getByLabelText("企业微信成员账号"), "zhangsan");
    await user.click(screen.getByRole("button", { name: "保存绑定" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(target.id, {
        ownerId: member.id,
        externalConversationId: "wecom-conversation-1",
        nearChatConversationId: null,
        assistantId: "66666666-6666-4666-8666-666666666666",
        deliveryKinds: ["REMINDER"],
        deliveryTarget: "zhangsan",
        enabled: true,
      }),
    );
  });

  it("服务端未提供公网回调地址时阻断复制且不猜测管理端 origin", async () => {
    const target = { ...connector(), callbackUrl: null };
    mockLoads([target]);

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={vi.fn()} />,
    );

    expect(await screen.findByText("需配置公网 HTTPS PUBLIC_BASE_URL")).toBeTruthy();
    expect((screen.getByRole("button", { name: /复制/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(
      `${window.location.origin}/api/connectors/wecom/${target.id}/callback`,
    );
  });

  it("编辑时不回显密钥，revision 冲突会刷新最新配置", async () => {
    const user = userEvent.setup();
    const target = connector();
    const list = mockLoads([target]);
    const update = vi
      .spyOn(api, "updateAdminConnector")
      .mockRejectedValue(new ApiError(409, "连接器配置已更新，请刷新后重试"));
    const notify = vi.fn();

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={notify} />,
    );

    await user.click(await screen.findByRole("button", { name: `编辑 ${target.name}` }));
    expect((screen.getByLabelText(/^应用 Secret/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^回调 Token/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^EncodingAESKey/) as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText("已安全保存").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "关闭连接器编辑" }));

    await user.click(screen.getByRole("button", { name: `停用 ${target.name}` }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(target.id, { revision: 4, enabled: false }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenCalledWith("配置已被其他管理员更新，已刷新到最新版本", "error");
  });

  it("从运维事件安全地进入对应连接器并预填会话绑定", async () => {
    const user = userEvent.setup();
    const target = connector("DINGTALK_STREAM");
    mockLoads([target]);
    const externalConversationId = "opaque-conversation-id-must-not-render-in-operations";
    const failedEvent: ConnectorOperationEvent = {
      id: "99999999-9999-4999-8999-999999999999",
      connectorId: target.id,
      provider: target.provider,
      connectorName: target.name,
      externalEventId: "opaque-event-id",
      externalConversationId,
      externalUserId: "opaque-user-id",
      kind: "TEXT",
      status: "FAILED",
      attempts: 1,
      nextAttemptAt: "2026-08-21T09:10:00.000Z",
      leaseExpiresAt: null,
      error: "未找到会话绑定",
      receivedAt: "2026-08-21T09:00:00.000Z",
      processedAt: null,
      prepared: false,
    };
    const health: ConnectorOperationsHealth = {
      events: { counts: { FAILED: 1 }, total: 1, oldestAt: failedEvent.receivedAt },
      jobs: { counts: {}, total: 0, oldestAt: null },
      checkedAt: "2026-08-21T09:15:00.000Z",
    };
    vi.spyOn(api, "connectorOperationsHealth").mockResolvedValue({ health });
    vi.spyOn(api, "connectorOperationEvents").mockResolvedValue({
      events: [failedEvent],
      nextCursor: null,
    });
    vi.spyOn(api, "connectorOperationJobs").mockResolvedValue({ jobs: [], nextCursor: null });

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={vi.fn()} />,
    );

    await user.click(await screen.findByRole("tab", { name: /故障与恢复/ }));
    const createBinding = await screen.findByRole("button", {
      name: `配置事件会话绑定 ${failedEvent.id.slice(0, 8)}`,
    });
    expect(document.body.textContent).not.toContain(externalConversationId);

    await user.click(createBinding);

    expect(screen.getByRole("tab", { name: /配置与映射/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(((await screen.findByLabelText("外部会话 ID")) as HTMLInputElement).value).toBe(
      externalConversationId,
    );
  });

  it("从已绑定事件进入编辑器时保留现有归属、投递类型和元数据", async () => {
    const user = userEvent.setup();
    const target = connector("DINGTALK_STREAM");
    const externalConversationId = "already-bound-conversation";
    const existing: ConnectorBinding = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      connectorId: target.id,
      ownerId: member.id,
      externalConversationId,
      nearChatConversationId: null,
      assistantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deliveryKinds: ["REMINDER", "SUMMARY"],
      hasDeliveryTarget: true,
      hasDingTalkOpenApiRoute: true,
      deliveryTargetExpiresAt: "2020-01-01T04:00:00.000Z",
      enabled: true,
      metadata: { source: "inbound" },
    };
    mockLoads([target], [], [existing]);
    const failedEvent: ConnectorOperationEvent = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      connectorId: target.id,
      provider: target.provider,
      connectorName: target.name,
      externalEventId: "event-id",
      externalConversationId,
      externalUserId: "user-id",
      kind: "TEXT",
      status: "FAILED",
      attempts: 1,
      nextAttemptAt: "2026-08-21T09:10:00.000Z",
      leaseExpiresAt: null,
      error: "处理失败",
      receivedAt: "2026-08-21T09:00:00.000Z",
      processedAt: null,
      prepared: false,
    };
    vi.spyOn(api, "connectorOperationsHealth").mockResolvedValue({
      health: {
        events: { counts: { FAILED: 1 }, total: 1, oldestAt: failedEvent.receivedAt },
        jobs: { counts: {}, total: 0, oldestAt: null },
        checkedAt: "2026-08-21T09:15:00.000Z",
      },
    });
    vi.spyOn(api, "connectorOperationEvents").mockResolvedValue({
      events: [failedEvent],
      nextCursor: null,
    });
    vi.spyOn(api, "connectorOperationJobs").mockResolvedValue({ jobs: [], nextCursor: null });
    const save = vi.spyOn(api, "saveConnectorBinding").mockResolvedValue({ binding: existing });

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={vi.fn()} />,
    );

    await user.click(await screen.findByRole("tab", { name: /故障与恢复/ }));
    await user.click(
      await screen.findByRole("button", {
        name: `配置事件会话绑定 ${failedEvent.id.slice(0, 8)}`,
      }),
    );

    expect(await screen.findByText("编辑会话绑定")).toBeTruthy();
    const ownerSelect = screen.getByRole("combobox", { name: "绑定用户" }) as HTMLSelectElement;
    expect(ownerSelect.value).toBe(member.id);
    expect(ownerSelect.disabled).toBe(true);
    expect((screen.getByLabelText("外部会话 ID") as HTMLInputElement).readOnly).toBe(true);
    expect(
      screen.getByText("已有绑定的外部会话不可更改；如需变更，请删除后重新绑定。"),
    ).toBeTruthy();
    expect((screen.getByLabelText(/个人助理 ID/) as HTMLInputElement).value).toBe(
      existing.assistantId,
    );
    expect((screen.getByRole("checkbox", { name: "提醒" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "摘要" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("当前可通过钉钉 OpenAPI 路由主动投递。")).toBeTruthy();
    expect(
      screen.getByText("取消投递类型会取消相关待处理队列；已 RUNNING 的投递可能已完成。"),
    ).toBeTruthy();
    expect(
      screen.getByText("停用后不会处理入站消息，并会取消待处理投递；已 RUNNING 的投递可能已完成。"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "保存绑定" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(target.id, {
        id: existing.id,
        ownerId: member.id,
        externalConversationId,
        nearChatConversationId: null,
        assistantId: existing.assistantId,
        deliveryKinds: ["REMINDER", "SUMMARY"],
        enabled: true,
        metadata: existing.metadata,
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: `删除绑定 ${externalConversationId}` }),
    );
    expect(
      screen.getByText(/将停止入站处理，待处理队列会取消；已 RUNNING 的投递可能已完成/),
    ).toBeTruthy();
  });

  it("钉钉会话 Webhook 校验未来失效时间并与绑定请求一起提交", async () => {
    const user = userEvent.setup();
    const target = connector("DINGTALK_STREAM");
    const waitingBinding: ConnectorBinding = {
      id: "88888888-8888-4888-8888-888888888888",
      connectorId: target.id,
      ownerId: admin.id,
      externalConversationId: "waiting-for-inbound",
      nearChatConversationId: null,
      assistantId: null,
      deliveryKinds: ["REMINDER"],
      hasDeliveryTarget: false,
      hasDingTalkOpenApiRoute: false,
      deliveryTargetExpiresAt: null,
      enabled: true,
      metadata: {},
    };
    const openApiFallbackBinding: ConnectorBinding = {
      ...waitingBinding,
      id: "99999999-9999-4999-8999-999999999999",
      externalConversationId: "open-api-fallback",
      hasDingTalkOpenApiRoute: true,
    };
    const validSessionBinding: ConnectorBinding = {
      ...waitingBinding,
      id: "66666666-6666-4666-8666-666666666666",
      externalConversationId: "valid-session",
      hasDeliveryTarget: true,
      deliveryTargetExpiresAt: "2099-01-01T04:00:00.000Z",
    };
    mockLoads([target], [], [validSessionBinding, openApiFallbackBinding, waitingBinding]);
    const expiresAt = "2099-01-01T12:00";
    const savedBinding: ConnectorBinding = {
      id: "77777777-7777-4777-8777-777777777777",
      connectorId: target.id,
      ownerId: admin.id,
      externalConversationId: "ding-conversation-1",
      nearChatConversationId: null,
      assistantId: null,
      deliveryKinds: ["REMINDER"],
      hasDeliveryTarget: true,
      hasDingTalkOpenApiRoute: false,
      deliveryTargetExpiresAt: new Date(expiresAt).toISOString(),
      enabled: true,
      metadata: {},
    };
    const save = vi.spyOn(api, "saveConnectorBinding").mockResolvedValue({
      binding: savedBinding,
    });
    const notify = vi.fn();

    render(
      <ConnectorSettingsPanel currentUser={admin} users={[admin, member]} onNotify={notify} />,
    );

    expect(
      await screen.findByText("等待该会话新消息获取投递路由，当前主动投递不可用"),
    ).toBeTruthy();
    expect(screen.getByText(/会话 Webhook 有效至/)).toBeTruthy();
    expect(screen.getByText("会话 Webhook 缺失，当前由钉钉 OpenAPI 路由投递")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "添加绑定" }));
    await user.type(screen.getByLabelText("外部会话 ID"), "ding-conversation-1");
    await user.click(screen.getByRole("checkbox", { name: "提醒" }));
    await user.type(
      screen.getByLabelText("钉钉会话 Webhook"),
      "https://oapi.dingtalk.com/robot/sendBySession?session=session-token",
    );
    fireEvent.change(screen.getByLabelText("Webhook 失效时间"), {
      target: { value: "2020-01-01T12:00" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "保存绑定" }).closest("form")!);
    expect(save).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("钉钉会话 Webhook 必须填写尚未过期的失效时间", "error");

    fireEvent.change(screen.getByLabelText("Webhook 失效时间"), {
      target: { value: expiresAt },
    });
    await user.click(screen.getByRole("button", { name: "保存绑定" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(target.id, {
        ownerId: admin.id,
        externalConversationId: "ding-conversation-1",
        nearChatConversationId: null,
        assistantId: null,
        deliveryKinds: ["REMINDER"],
        deliveryTarget: "https://oapi.dingtalk.com/robot/sendBySession?session=session-token",
        deliveryTargetExpiresAt: new Date(expiresAt).toISOString(),
        enabled: true,
      }),
    );
  });
});
