import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AssistantInvocation } from "../types";
import { AssistantInvocationTray } from "./AssistantInvocationTray";

const preview: AssistantInvocation = {
  id: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8444-444444444444",
  sourceMessageId: "55555555-5555-4555-8555-555555555555",
  assistantId: "11111111-1111-4111-8111-111111111111",
  assistantName: "分析搭档",
  assistantAvatarColor: "#2F9D83",
  mode: "PRIVATE_PREVIEW",
  status: "WAITING_CONFIRMATION",
  prompt: "总结当前安排",
  resultText: "周五 16:30 发布，发布前完成回归测试。",
  errorMessage: null,
  resultMessageId: null,
  createdAt: "2026-08-15T08:00:00.000Z",
  updatedAt: "2026-08-15T08:00:01.000Z",
};

it("私有预览明确提示可见范围并由用户确认后发送", async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onUseDraft = vi.fn().mockResolvedValue(undefined);
  const onDismiss = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(
    <AssistantInvocationTray
      invocations={[preview]}
      onConfirm={onConfirm}
      onUseDraft={onUseDraft}
      onDismiss={onDismiss}
    />,
  );

  expect(screen.getByText("私有预览")).toBeTruthy();
  expect(screen.getByText(preview.resultText!)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "发送到会话" }));
  expect(onConfirm).toHaveBeenCalledWith(preview);
});

it("生成中只显示紧凑状态，不提前提供发送操作", () => {
  render(
    <AssistantInvocationTray
      invocations={[{ ...preview, status: "RUNNING", resultText: null }]}
      onConfirm={vi.fn()}
      onUseDraft={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(screen.getByText("正在阅读当前会话")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发送到会话" })).toBeNull();
});
