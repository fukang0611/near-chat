import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferredVoiceMimeType, VoicePostcardRecorder } from "./VoicePostcardRecorder";

class MediaRecorderStub {
  static isTypeSupported(type: string) {
    return type === "audio/webm;codecs=opus";
  }

  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

describe("VoicePostcardRecorder", () => {
  const stopTrack = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", MediaRecorderStub);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    stopTrack.mockReset();
  });

  it("选择浏览器支持的高效语音格式", () => {
    expect(preferredVoiceMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("录制后必须先试听，再确认上传语音文件", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<VoicePostcardRecorder peerName="林小满" onDismiss={onDismiss} onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    expect(await screen.findByText("正在聆听")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "停止录制" }));
    expect(await screen.findByText("试听后再发送")).toBeTruthy();
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:voice-preview");

    await user.click(screen.getByRole("button", { name: "发送语音" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const [file, duration] = onSend.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(file.name).toMatch(/^语音明信片-\d+秒-/);
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("麦克风被拒绝时保留弹窗并给出可恢复提示", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("permission denied", "NotAllowedError")),
      },
    });
    const user = userEvent.setup();
    render(<VoicePostcardRecorder peerName="林小满" onDismiss={vi.fn()} onSend={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "开始录制" }));

    expect(await screen.findByText(/麦克风权限未授权/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始录制" })).toBeTruthy();
  });

  it("授权框等待期间关闭组件后会立即释放随后取得的麦克风", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockImplementation(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveStream = resolve;
            }),
        ),
      },
    });
    const user = userEvent.setup();
    const { unmount } = render(
      <VoicePostcardRecorder peerName="林小满" onDismiss={vi.fn()} onSend={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "开始录制" }));
    unmount();
    resolveStream?.({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);

    await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce());
  });
});
