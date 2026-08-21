import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api";
import type {
  ConnectorConfig,
  ConnectorOperationEvent,
  ConnectorOperationJob,
  ConnectorOperationsHealth,
} from "../types";
import { ConnectorOperationsPanel } from "./ConnectorOperationsPanel";

const connector: ConnectorConfig = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "DINGTALK_STREAM",
  name: "研发群机器人",
  enabled: true,
  revision: 2,
  callbackUrl: null,
  hasClientId: true,
  hasClientSecret: true,
  hasWebhookUrl: false,
  hasCallbackToken: false,
  hasEncodingAesKey: false,
  hasCorpId: false,
  hasAgentId: false,
  runtime: { running: true, startedAt: "2026-08-21T08:00:00.000Z", error: null },
  createdAt: "2026-08-21T07:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
};

const health: ConnectorOperationsHealth = {
  events: {
    counts: { FAILED: 1, PROCESSING: 1, PROCESSED: 8 },
    total: 10,
    oldestAt: "2026-08-20T07:00:00.000Z",
  },
  jobs: {
    counts: { FAILED: 1, RUNNING: 1, SUCCEEDED: 18 },
    total: 20,
    oldestAt: "2026-08-19T07:00:00.000Z",
  },
  checkedAt: "2026-08-21T09:00:00.000Z",
};

const failedEvent: ConnectorOperationEvent = {
  id: "44444444-4444-4444-8444-444444444444",
  connectorId: connector.id,
  provider: connector.provider,
  connectorName: connector.name,
  externalEventId: "external-event-must-not-render",
  externalConversationId: "conversation-must-not-render",
  externalUserId: "user-must-not-render",
  kind: "TEXT",
  status: "FAILED",
  attempts: 3,
  nextAttemptAt: "2026-08-21T09:10:00.000Z",
  leaseExpiresAt: null,
  error:
    "POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=super-private failed token=hidden-token",
  receivedAt: "2026-08-21T08:30:00.000Z",
  processedAt: null,
  prepared: true,
};

const failedJob: ConnectorOperationJob = {
  id: "55555555-5555-4555-8555-555555555555",
  connectorId: connector.id,
  provider: connector.provider,
  connectorName: connector.name,
  kind: "REMINDER",
  status: "FAILED",
  attempts: 2,
  idempotencyKey: "private-idempotency-key-must-not-render",
  nextAttemptAt: "2026-08-21T09:10:00.000Z",
  leaseExpiresAt: null,
  error: "Authorization: Bearer super-secret failed",
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:45:00.000Z",
};

function mockLoads() {
  const healthCall = vi.spyOn(api, "connectorOperationsHealth").mockResolvedValue({ health });
  const eventCall = vi
    .spyOn(api, "connectorOperationEvents")
    .mockResolvedValue({ events: [failedEvent], nextCursor: null });
  const jobCall = vi
    .spyOn(api, "connectorOperationJobs")
    .mockResolvedValue({ jobs: [failedJob], nextCursor: null });
  return { healthCall, eventCall, jobCall };
}

describe("ConnectorOperationsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("默认只加载失败队列并渲染不含正文、外部标识和凭据的安全摘要", async () => {
    const { eventCall, jobCall } = mockLoads();

    render(
      <ConnectorOperationsPanel
        connectors={[connector]}
        onNotify={vi.fn()}
        onCreateBinding={vi.fn()}
      />,
    );

    expect(await screen.findByText("已缓存处理结果", { exact: false })).toBeTruthy();
    expect(screen.getByText("全局队列健康度")).toBeTruthy();
    expect(screen.getByText("不受上方连接器筛选影响")).toBeTruthy();
    expect(screen.getByText("全局累计队列记录")).toBeTruthy();
    expect(eventCall).toHaveBeenCalledWith({ status: "FAILED", limit: 50 });
    expect(jobCall).toHaveBeenCalledWith({ status: "FAILED", limit: 50 });
    expect(screen.getByText(/外部地址已隐藏/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("super-private");
    expect(document.body.textContent).not.toContain("hidden-token");
    expect(document.body.textContent).not.toContain("super-secret");
    expect(document.body.textContent).not.toContain(failedEvent.externalEventId);
    expect(document.body.textContent).not.toContain(failedEvent.externalUserId);
    expect(document.body.textContent).not.toContain(failedJob.idempotencyKey);
  });

  it("使用服务端游标加载更早记录并去重追加", async () => {
    const user = userEvent.setup();
    const cursor = {
      before: "2026-08-21T08:30:00.000000Z",
      beforeId: failedEvent.id,
    };
    const olderEvent: ConnectorOperationEvent = {
      ...failedEvent,
      id: "66666666-6666-4666-8666-666666666666",
      receivedAt: "2026-08-20T08:30:00.000Z",
    };
    vi.spyOn(api, "connectorOperationsHealth").mockResolvedValue({ health });
    const eventCall = vi
      .spyOn(api, "connectorOperationEvents")
      .mockResolvedValueOnce({ events: [failedEvent], nextCursor: cursor })
      .mockResolvedValueOnce({ events: [failedEvent, olderEvent], nextCursor: null });
    vi.spyOn(api, "connectorOperationJobs").mockResolvedValue({
      jobs: [failedJob],
      nextCursor: null,
    });

    render(
      <ConnectorOperationsPanel
        connectors={[connector]}
        onNotify={vi.fn()}
        onCreateBinding={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "加载更早事件" }));

    await waitFor(() =>
      expect(eventCall).toHaveBeenNthCalledWith(2, {
        status: "FAILED",
        limit: 50,
        cursor,
      }),
    );
    expect(await screen.findByText(/#66666666/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更早事件" })).toBeNull();
  });

  it("重试前要求确认，成功后刷新事件队列与健康统计", async () => {
    const user = userEvent.setup();
    const { healthCall, eventCall } = mockLoads();
    const retry = vi.spyOn(api, "retryConnectorOperationEvent").mockResolvedValue({
      event: { id: failedEvent.id, connectorId: connector.id, status: "RECEIVED" },
    });
    const notify = vi.fn();

    render(
      <ConnectorOperationsPanel
        connectors={[connector]}
        onNotify={notify}
        onCreateBinding={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: `重试 事件 ${failedEvent.id.slice(0, 8)}`,
      }),
    );
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText(/重试可能再次触发外部发送/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认重试" }));

    await waitFor(() => expect(retry).toHaveBeenCalledWith(failedEvent.id));
    await waitFor(() => expect(eventCall).toHaveBeenCalledTimes(2));
    expect(healthCall).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith("入站事件已重新排队", "success");
  });

  it("状态冲突时关闭确认层并刷新全部队列", async () => {
    const user = userEvent.setup();
    const { healthCall, eventCall, jobCall } = mockLoads();
    vi.spyOn(api, "cancelConnectorOperationJob").mockRejectedValue(
      new ApiError(409, "连接器投递不存在或当前状态不允许取消"),
    );
    const notify = vi.fn();

    render(
      <ConnectorOperationsPanel
        connectors={[connector]}
        onNotify={notify}
        onCreateBinding={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: `取消 投递 ${failedJob.id.slice(0, 8)}`,
      }),
    );
    await user.click(screen.getByRole("button", { name: "确认取消" }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith("操作状态已变化，已刷新最新队列", "error"),
    );
    expect(healthCall).toHaveBeenCalledTimes(2);
    expect(eventCall).toHaveBeenCalledTimes(2);
    expect(jobCall).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
