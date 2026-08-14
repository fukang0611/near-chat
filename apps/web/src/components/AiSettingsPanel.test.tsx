import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AdminAiSettings, AiCapabilities } from "../types";
import { AiSettingsPanel } from "./AiSettingsPanel";

const capabilities: AiCapabilities = {
  enabled: true,
  status: "READY",
  reason: "AI 已就绪，可使用 2 个对话模型",
  features: {
    knowledgeManagement: true,
    knowledgeIndexing: true,
    knowledgeSearch: true,
    knowledgeAnswer: true,
    personalAssistants: true,
    messageActions: true,
  },
  provider: {
    chatModel: "gpt-4.1-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  },
};

const settings: AdminAiSettings = {
  enabled: true,
  defaultChatModelId: "11111111-1111-4111-8111-111111111111",
  models: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "通用助手",
      baseUrl: "https://llm.example.com/v1",
      providerModel: "gpt-4.1-mini",
      enabled: true,
      hasApiKey: true,
      isDefault: true,
      updatedAt: "2026-08-14T10:00:00.000Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "深度推理",
      baseUrl: "http://reasoning.local:8000/v1",
      providerModel: "reasoning-32b",
      enabled: true,
      hasApiKey: false,
      isDefault: false,
      updatedAt: "2026-08-14T10:00:00.000Z",
    },
  ],
  embeddingBaseUrl: "https://llm.example.com/v1",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  hasEmbeddingApiKey: true,
  revision: 3,
  updatedAt: "2026-08-14T10:00:00.000Z",
};

describe("AiSettingsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("管理员可选择唯一默认模型并热应用全局设置", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "adminAiSettings").mockResolvedValue({ settings, capabilities });
    const update = vi.spyOn(api, "updateAdminAiSettings").mockResolvedValue({
      settings: {
        ...settings,
        defaultChatModelId: settings.models[1]!.id,
        models: settings.models.map((model, index) => ({ ...model, isDefault: index === 1 })),
      },
      capabilities: {
        ...capabilities,
        provider: { ...capabilities.provider, chatModel: "reasoning-32b" },
      },
      reindexQueued: 0,
    });
    const changed = vi.fn();

    render(<AiSettingsPanel onNotify={vi.fn()} onCapabilitiesChanged={changed} />);

    expect(await screen.findByText("通用助手")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "设为默认" }));
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ defaultChatModelId: settings.models[1]!.id, enabled: true }),
      ),
    );
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: "READY" }));
  });

  it("密钥只显示已保存状态，留空保存不会覆盖原值", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "adminAiSettings").mockResolvedValue({ settings, capabilities });
    const update = vi.spyOn(api, "updateAdminAiSettings").mockResolvedValue({
      settings,
      capabilities,
      reindexQueued: 0,
    });

    render(<AiSettingsPanel onNotify={vi.fn()} onCapabilitiesChanged={vi.fn()} />);
    expect(await screen.findByText("已安全保存")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![0].embeddingApiKey).toBeUndefined();
    expect(screen.queryByDisplayValue("sk-near-chat-private")).toBeNull();
  });
});
