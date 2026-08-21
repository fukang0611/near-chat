import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("connector admin api", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the operations list defaults and connector filter expected by the server", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ events: [] }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.connectorOperationEvents({ connectorId: "connector-1" });
    await api.connectorOperationJobs();
    await api.connectorOperationEvents({
      cursor: {
        before: "2026-08-21T08:30:00.000000Z",
        beforeId: "44444444-4444-4444-8444-444444444444",
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/admin/connectors/operations/events?status=FAILED&limit=50&connectorId=connector-1",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/admin/connectors/operations/jobs?status=FAILED&limit=50",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/admin/connectors/operations/events?status=FAILED&limit=50&before=2026-08-21T08%3A30%3A00.000000Z&beforeId=44444444-4444-4444-8444-444444444444",
    );
  });

  it.each([
    ["retry event", () => api.retryConnectorOperationEvent("event-1"), "/events/event-1/retry"],
    ["cancel event", () => api.cancelConnectorOperationEvent("event-1"), "/events/event-1/cancel"],
    ["retry job", () => api.retryConnectorOperationJob("job-1"), "/jobs/job-1/retry"],
    ["cancel job", () => api.cancelConnectorOperationJob("job-1"), "/jobs/job-1/cancel"],
  ])("posts the %s mutation to the exact operations endpoint", async (_name, call, suffix) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        event: { id: "event-1", connectorId: "connector-1", status: "RECEIVED" },
        job: { id: "job-1", connectorId: "connector-1", status: "QUEUED" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await call();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/admin/connectors/operations${suffix}`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it("serializes DingTalk delivery target expiry with the binding request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        binding: {
          id: "binding-1",
          connectorId: "connector-1",
          ownerId: "owner-1",
          externalConversationId: "conversation-1",
          nearChatConversationId: null,
          assistantId: null,
          deliveryKinds: ["REMINDER"],
          hasDeliveryTarget: true,
          hasDingTalkOpenApiRoute: true,
          deliveryTargetExpiresAt: "2099-01-01T04:00:00.000Z",
          enabled: true,
          metadata: {},
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deliveryTargetExpiresAt = "2099-01-01T04:00:00.000Z";

    const result = await api.saveConnectorBinding("connector-1", {
      ownerId: "owner-1",
      externalConversationId: "conversation-1",
      deliveryKinds: ["REMINDER"],
      deliveryTarget: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      deliveryTargetExpiresAt,
      enabled: true,
    });

    expect(result.binding.hasDingTalkOpenApiRoute).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/connectors/connector-1/bindings");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(String(request?.body))).toEqual(
      expect.objectContaining({ deliveryTargetExpiresAt }),
    );
  });
});
