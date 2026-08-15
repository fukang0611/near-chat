import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AiAssistant, AiAssistantFile, ChatFilePage } from "../types";
import { AssistantFilesPanel } from "./AssistantFilesPanel";

const assistant: AiAssistant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "资料助理",
  description: "读取项目资料",
  category: "ANALYSIS",
  instructions: "依据资料回答。",
  avatarColor: "#3C83C8",
  modelId: null,
  model: null,
  knowledgeBaseIds: [],
  toolGrants: { crossConversationSearch: false, privateMemoryRead: false },
  messageCount: 0,
  lastMessageAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
};

const file: AiAssistantFile = {
  id: "22222222-2222-4222-8222-222222222222",
  assistantId: assistant.id,
  origin: "CHAT",
  sourceMessageId: null,
  attachment: {
    id: "33333333-3333-4333-8333-333333333333",
    originalName: "迭代计划.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
  },
  processable: true,
  createdAt: "2026-08-14T08:30:00.000Z",
};

const chatFiles: ChatFilePage = {
  files: [
    {
      attachment: file.attachment,
      category: "FILE",
      messageId: "44444444-4444-4444-8444-444444444444",
      conversationId: "55555555-5555-4555-8555-555555555555",
      senderId: "66666666-6666-4666-8666-666666666666",
      senderName: "林小满",
      messageText: "本周迭代计划",
      createdAt: file.createdAt,
    },
  ],
  total: 1,
  totalBytes: file.attachment.sizeBytes,
  offset: 0,
  hasMore: false,
};

describe("AssistantFilesPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("从当前用户可见的聊天文件库添加引用", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "chatFiles").mockResolvedValue(chatFiles);
    const addFile = vi.spyOn(api, "addAiAssistantFile").mockResolvedValue({ file });
    const onFileAdded = vi.fn();
    const onNotice = vi.fn();

    render(
      <AssistantFilesPanel
        assistant={assistant}
        files={[]}
        loading={false}
        onFileAdded={onFileAdded}
        onFileRemoved={vi.fn()}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "从聊天添加" })[0]!);
    expect(await screen.findByText("迭代计划.pdf")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^添加$/ }));

    await waitFor(() =>
      expect(addFile).toHaveBeenCalledWith(assistant.id, file.attachment.id, "CHAT"),
    );
    expect(onFileAdded).toHaveBeenCalledWith(file);
    expect(onNotice).toHaveBeenCalledWith("success", "“迭代计划.pdf”已加入文件工作区");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "从聊天添加文件" })).toBeNull();
  });

  it("移除前使用界面内确认，并只删除助理引用", async () => {
    const user = userEvent.setup();
    const removeFile = vi.spyOn(api, "deleteAiAssistantFile").mockResolvedValue(undefined);
    const onFileRemoved = vi.fn();

    render(
      <AssistantFilesPanel
        assistant={assistant}
        files={[file]}
        loading={false}
        onFileAdded={vi.fn()}
        onFileRemoved={onFileRemoved}
        onNotice={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "移除 迭代计划.pdf" }));
    expect(removeFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^移除$/ }));

    await waitFor(() => expect(removeFile).toHaveBeenCalledWith(assistant.id, file.id));
    expect(onFileRemoved).toHaveBeenCalledWith(file.id);
  });
});
