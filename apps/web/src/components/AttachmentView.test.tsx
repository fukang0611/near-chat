import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Attachment } from "../types";
import { AttachmentView } from "./AttachmentView";

const imageAttachment: Attachment = {
  id: "image-attachment",
  originalName: "界面参考.png",
  contentType: "image/png",
  sizeBytes: 393_216,
};

describe("AttachmentView 图片预览", () => {
  beforeEach(() => {
    vi.spyOn(api, "fileBlob").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:near-chat-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("只在点击下载按钮时读取原图，点击图片外部关闭预览", async () => {
    const user = userEvent.setup();
    render(<AttachmentView attachment={imageAttachment} />);

    const trigger = await screen.findByRole("button", { name: "预览图片 界面参考.png" });
    await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("false"));
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "预览图片 界面参考.png" });
    await user.click(screen.getAllByRole("img", { name: "界面参考.png" })[1]);
    expect(screen.getByRole("dialog", { name: "预览图片 界面参考.png" })).toBeTruthy();
    expect(api.fileBlob).toHaveBeenCalledTimes(1);

    await user.click(dialog);
    expect(screen.queryByRole("dialog", { name: "预览图片 界面参考.png" })).toBeNull();
    expect(api.fileBlob).toHaveBeenCalledTimes(1);

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "下载原图 界面参考.png" }));
    await waitFor(() => expect(api.fileBlob).toHaveBeenCalledWith(imageAttachment.id, true));
  });

  it("有回复能力时在图片预览中提供圈图入口", async () => {
    const user = userEvent.setup();
    render(<AttachmentView attachment={imageAttachment} onAnnotate={vi.fn()} />);

    const trigger = await screen.findByRole("button", { name: "预览图片 界面参考.png" });
    await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("false"));
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "圈图回复 界面参考.png" }));

    expect(screen.getByRole("dialog", { name: "圈图回复" })).toBeTruthy();
    expect(api.fileBlob).toHaveBeenCalledTimes(1);
  });
});

describe("AttachmentView 语音明信片", () => {
  const audioAttachment: Attachment = {
    id: "audio-attachment",
    originalName: "语音明信片-8秒.webm",
    contentType: "audio/webm",
    sizeBytes: 16_384,
  };

  beforeEach(() => {
    vi.spyOn(api, "fileBlob").mockResolvedValue(new Blob(["voice"], { type: "audio/webm" }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:near-chat-audio");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("通过鉴权 Blob 加载播放器，下载仍需显式点击", async () => {
    const user = userEvent.setup();
    render(<AttachmentView attachment={audioAttachment} />);

    expect(await screen.findByText("语音明信片")).toBeTruthy();
    await waitFor(() => expect(api.fileBlob).toHaveBeenCalledWith(audioAttachment.id));
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:near-chat-audio");
    expect(api.fileBlob).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /下载语音/ }));
    await waitFor(() => expect(api.fileBlob).toHaveBeenCalledWith(audioAttachment.id, true));
  });
});
