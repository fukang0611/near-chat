import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Message, MessageAiActionResult } from "../types";
import { MessageAiActionDialog } from "./MessageAiActionDialog";

const model = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "团队模型",
  providerModel: "gpt-test",
  isDefault: true,
};

const message: Message = {
  id: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  senderId: "44444444-4444-4444-8444-444444444444",
  senderName: "林小满",
  senderAvatarColor: "#E76F88",
  senderAvatarUrl: null,
  clientMessageId: "55555555-5555-4555-8555-555555555555",
  type: "TEXT",
  textContent: "请在周五前完成发布回归，并同步结果。",
  createdAt: "2026-08-14T10:00:00.000Z",
  recalledAt: null,
  recallableUntil: "2026-08-14T10:02:00.000Z",
  replyTo: null,
  attachments: [],
  reactions: [],
  receipt: { recipientCount: 1, deliveredCount: 1, readCount: 1 },
};

const actionResult: MessageAiActionResult = {
  action: "SUMMARIZE",
  targetLanguage: null,
  result: "结论：周五前完成发布回归并同步结果。",
  model,
  source: {
    messageId: message.id,
    senderName: message.senderName,
    conversationTitle: "项目群",
    textPreview: message.textContent!,
    attachments: [],
    truncated: false,
  },
  generatedAt: "2026-08-14T10:01:00.000Z",
};

describe("MessageAiActionDialog", () => {
  beforeEach(() => {
    vi.spyOn(api, "aiModels").mockResolvedValue({
      models: [model],
      selectedModelId: model.id,
      defaultModelId: model.id,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("按用户选择生成结果，并由用户确认后追加到输入框", async () => {
    const user = userEvent.setup();
    const run = vi.spyOn(api, "runMessageAiAction").mockResolvedValue(actionResult);
    const onApplyToDraft = vi.fn().mockReturnValue(true);
    const onClose = vi.fn();

    render(
      <MessageAiActionDialog message={message} onClose={onClose} onApplyToDraft={onApplyToDraft} />,
    );

    await screen.findByRole("option", { name: "团队模型 · 默认" });
    await user.click(screen.getByRole("button", { name: "开始总结要点" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(message.id, {
        action: "SUMMARIZE",
        targetLanguage: undefined,
        modelId: model.id,
      }),
    );
    expect(await screen.findByText(actionResult.result)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "追加到输入框" }));
    expect(onApplyToDraft).toHaveBeenCalledWith(actionResult.result);
    expect(onClose).toHaveBeenCalled();
  });

  it("翻译操作显式传递目标语言", async () => {
    const user = userEvent.setup();
    const run = vi.spyOn(api, "runMessageAiAction").mockResolvedValue({
      ...actionResult,
      action: "TRANSLATE",
      targetLanguage: "CHINESE",
    });

    render(
      <MessageAiActionDialog
        message={message}
        onClose={vi.fn()}
        onApplyToDraft={vi.fn().mockReturnValue(true)}
      />,
    );
    await screen.findByRole("option", { name: "团队模型 · 默认" });
    await user.click(screen.getByRole("button", { name: "翻译内容" }));
    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.click(screen.getByRole("button", { name: "开始翻译为中文" }));

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(message.id, {
        action: "TRANSLATE",
        targetLanguage: "CHINESE",
        modelId: model.id,
      }),
    );
  });

  it("草稿容量不足时保留结果面板", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "runMessageAiAction").mockResolvedValue(actionResult);
    const onClose = vi.fn();
    const onApplyToDraft = vi.fn().mockReturnValue(false);

    render(
      <MessageAiActionDialog message={message} onClose={onClose} onApplyToDraft={onApplyToDraft} />,
    );
    await screen.findByRole("option", { name: "团队模型 · 默认" });
    await user.click(screen.getByRole("button", { name: "开始总结要点" }));
    await screen.findByText(actionResult.result);
    await user.click(screen.getByRole("button", { name: "追加到输入框" }));

    expect(onApplyToDraft).toHaveBeenCalledWith(actionResult.result);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "AI 快捷处理" })).toBeTruthy();
  });
});
