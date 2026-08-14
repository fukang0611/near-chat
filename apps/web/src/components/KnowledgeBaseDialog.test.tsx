import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AiCapabilities, KnowledgeBase, KnowledgeDocument } from "../types";
import { KnowledgeBaseDialog } from "./KnowledgeBaseDialog";

const capabilities: AiCapabilities = {
  enabled: true,
  status: "READY",
  reason: "知识库检索与问答已就绪",
  features: {
    knowledgeManagement: true,
    knowledgeIndexing: true,
    knowledgeSearch: true,
    knowledgeAnswer: true,
    personalAssistants: true,
  },
  provider: {
    chatModel: "local-chat",
    embeddingModel: "local-embedding",
    embeddingDimensions: 1024,
  },
};

const base: KnowledgeBase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "产品资料",
  description: "团队产品与交付手册",
  documentCount: 1,
  readyDocumentCount: 1,
  createdAt: "2026-08-14T09:00:00.000Z",
  updatedAt: "2026-08-14T09:00:00.000Z",
};

const document: KnowledgeDocument = {
  id: "22222222-2222-4222-8222-222222222222",
  knowledgeBaseId: base.id,
  attachment: {
    id: "33333333-3333-4333-8333-333333333333",
    originalName: "NearChat 使用手册.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
  },
  status: "READY",
  chunkCount: 12,
  errorMessage: null,
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
};

describe("KnowledgeBaseDialog", () => {
  beforeEach(() => {
    vi.spyOn(api, "knowledgeBases").mockResolvedValue({ knowledgeBases: [base] });
    vi.spyOn(api, "knowledgeDocuments").mockResolvedValue({ documents: [document] });
  });

  afterEach(() => vi.restoreAllMocks());

  it("呈现原生知识库、索引状态和可追溯检索结果", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "searchKnowledge").mockResolvedValue({
      mode: "HYBRID",
      sources: [
        {
          chunkId: "44444444-4444-4444-8444-444444444444",
          score: 0.91,
          excerpt: "NearChat 的文件保存在团队自己的 MinIO 服务中。",
          position: 2,
          document: {
            id: document.id,
            name: document.attachment.originalName,
            attachment: document.attachment,
          },
        },
      ],
    });

    render(<KnowledgeBaseDialog capabilities={capabilities} onClose={vi.fn()} />);

    expect(await screen.findByText("NearChat 使用手册.pdf")).toBeTruthy();
    expect(screen.getByText("可检索")).toBeTruthy();
    await user.type(screen.getByPlaceholderText("查找文档中的内容…"), "文件保存在哪里");
    await user.click(screen.getByRole("button", { name: "开始检索" }));

    await waitFor(() =>
      expect(api.searchKnowledge).toHaveBeenCalledWith(base.id, "文件保存在哪里"),
    );
    expect(await screen.findByText(/文件保存在团队自己的 MinIO/)).toBeTruthy();
    expect(screen.getByText("91% 相关")).toBeTruthy();
  });

  it("新建知识库后立即切换到新空间", async () => {
    const user = userEvent.setup();
    const created = { ...base, id: "55555555-5555-4555-8555-555555555555", name: "项目复盘" };
    vi.spyOn(api, "createKnowledgeBase").mockResolvedValue({ knowledgeBase: created });

    render(<KnowledgeBaseDialog capabilities={capabilities} onClose={vi.fn()} />);
    await screen.findByText("NearChat 使用手册.pdf");
    await user.click(screen.getByRole("button", { name: "新建知识库" }));
    await user.type(screen.getByPlaceholderText("例如：产品资料"), "项目复盘");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(api.createKnowledgeBase).toHaveBeenCalledWith({ name: "项目复盘", description: "" }),
    );
    expect(await screen.findByText("知识库已创建")).toBeTruthy();
  });

  it("使用界面内确认而不是系统弹框删除知识库", async () => {
    const user = userEvent.setup();
    const deleteBase = vi.spyOn(api, "deleteKnowledgeBase").mockResolvedValue(undefined);

    render(<KnowledgeBaseDialog capabilities={capabilities} onClose={vi.fn()} />);
    await screen.findByText("NearChat 使用手册.pdf");
    await user.click(screen.getByRole("button", { name: "删除知识库" }));

    expect(deleteBase).not.toHaveBeenCalled();
    expect(screen.getByText("确认删除？")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认删除知识库" }));

    await waitFor(() => expect(deleteBase).toHaveBeenCalledWith(base.id));
    expect(await screen.findByText("知识库已删除")).toBeTruthy();
  });
});
