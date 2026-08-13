import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../types";
import { ImageAnnotationDialog } from "./ImageAnnotationDialog";

const attachment: Attachment = {
  id: "image-one",
  originalName: "方案截图.jpg",
  contentType: "image/jpeg",
  sizeBytes: 128_000,
};

const originalImage = globalThis.Image;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
const originalGetBoundingClientRect = HTMLCanvasElement.prototype.getBoundingClientRect;
const originalSetPointerCapture = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "setPointerCapture",
);
const originalHasPointerCapture = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "hasPointerCapture",
);
const originalReleasePointerCapture = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "releasePointerCapture",
);

function restorePrototypeProperty(name: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, name, descriptor);
  else delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[name];
}

describe("ImageAnnotationDialog", () => {
  beforeEach(() => {
    class FakeImage {
      decoding = "async";
      naturalWidth = 1200;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;

    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      lineCap: "round",
      lineJoin: "round",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
    };
    HTMLCanvasElement.prototype.getContext = vi.fn(() => context) as never;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) =>
      callback(new Blob(["annotated"], { type: "image/png" })),
    );
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 0,
          top: 0,
          width: 600,
          height: 400,
          right: 600,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperties(HTMLCanvasElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
  });

  afterEach(() => {
    globalThis.Image = originalImage;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    HTMLCanvasElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    restorePrototypeProperty("setPointerCapture", originalSetPointerCapture);
    restorePrototypeProperty("hasPointerCapture", originalHasPointerCapture);
    restorePrototypeProperty("releasePointerCapture", originalReleasePointerCapture);
    vi.restoreAllMocks();
  });

  it("绘制矩形后生成新 PNG 并发送，原附件名保持不变", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(file: File) => Promise<boolean>>(async () => true);
    const onDismiss = vi.fn();
    render(
      <ImageAnnotationDialog
        attachment={attachment}
        imageUrl="blob:source-image"
        onDismiss={onDismiss}
        onSend={onSend}
      />,
    );

    const canvas = await screen.findByLabelText("图片标注画布");
    await waitFor(() => expect(canvas.classList.contains("is-ready")).toBe(true));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 80, clientY: 70 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 310, clientY: 220 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 310, clientY: 220 });

    const sendButton = screen.getByRole("button", { name: "发送圈图" });
    await waitFor(() => expect(sendButton.hasAttribute("disabled")).toBe(false));
    await user.click(sendButton);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const generated = onSend.mock.calls[0]?.[0];
    expect(generated).toBeInstanceOf(File);
    expect(generated?.name).toBe("圈图-方案截图.png");
    expect(generated?.type).toBe("image/png");
    expect(attachment.originalName).toBe("方案截图.jpg");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("撤销和清空不会误发，取消直接退出", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(file: File) => Promise<boolean>>(async () => true);
    const onDismiss = vi.fn();
    render(
      <ImageAnnotationDialog
        attachment={attachment}
        imageUrl="blob:source-image"
        onDismiss={onDismiss}
        onSend={onSend}
      />,
    );
    await screen.findByLabelText("图片标注画布");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
