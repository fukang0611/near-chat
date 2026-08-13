import { describe, expect, it } from "vitest";
import { buildClipboardRelayPayload, CLIPBOARD_RELAY_MAX_IMAGE_BYTES } from "./clipboard-relay";

const baseSnapshot = {
  id: "relay-one",
  capturedAt: "2026-08-13T12:00:00.000Z",
};

describe("buildClipboardRelayPayload", () => {
  it("同时保留可选文字和 PNG 图片", () => {
    const payload = buildClipboardRelayPayload({
      ...baseSnapshot,
      text: "  项目进度已更新  ",
      imagePng: new Uint8Array([137, 80, 78, 71]),
    });

    expect(payload.text).toBe("项目进度已更新");
    expect(payload.imageDataUrl).toBe("data:image/png;base64,iVBORw==");
    expect(payload.imageSizeBytes).toBe(4);
    expect(payload.issue).toBeNull();
  });

  it("为空剪贴板提供明确原因", () => {
    expect(buildClipboardRelayPayload({ ...baseSnapshot, text: " ", imagePng: null }).issue).toBe(
      "剪贴板中没有可发送的文字或图片",
    );
  });

  it("拒绝超过消息或附件上限的内容", () => {
    expect(
      buildClipboardRelayPayload({
        ...baseSnapshot,
        text: "字".repeat(5_001),
        imagePng: null,
      }).issue,
    ).toContain("5000");
    expect(
      buildClipboardRelayPayload({
        ...baseSnapshot,
        text: "",
        imagePng: { byteLength: CLIPBOARD_RELAY_MAX_IMAGE_BYTES + 1 } as Uint8Array,
      }).issue,
    ).toContain("50 MB");
  });
});
