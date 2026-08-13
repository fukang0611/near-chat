import { LoaderCircle, Mic2, RotateCcw, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes } from "../utils/format";

const MAX_DURATION_MS = 60_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const mimeCandidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"] as const;

export function preferredVoiceMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return mimeCandidates.find((mime) => MediaRecorder.isTypeSupported?.(mime)) ?? "";
}

function voiceErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "麦克风权限未授权，请在浏览器或系统设置中允许后重试";
  }
  if (name === "NotFoundError") return "没有找到可用的麦克风";
  return "暂时无法开始录音，请检查麦克风是否被其他应用占用";
}

function formatRecorderTime(milliseconds: number): string {
  const seconds = Math.min(60, Math.max(0, Math.ceil(milliseconds / 1_000)));
  return `0:${String(seconds).padStart(2, "0")}`;
}

interface VoicePreview {
  blob: Blob;
  url: string;
  durationSeconds: number;
  mimeType: string;
}

interface VoicePostcardRecorderProps {
  peerName: string;
  onDismiss: () => void;
  onSend: (file: File, durationSeconds: number) => Promise<boolean>;
}

/**
 * 麦克风只在用户点击“开始录制”后申请；录音先停留在本地预览，确认后才进入
 * 现有附件上传与消息发送链路。
 */
export function VoicePostcardRecorder({ peerName, onDismiss, onSend }: VoicePostcardRecorderProps) {
  const [phase, setPhase] = useState<"idle" | "recording" | "preview">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [preview, setPreview] = useState<VoicePreview | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const previewRef = useRef<VoicePreview | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearTimers = useCallback(() => {
    if (tickerRef.current !== null) window.clearInterval(tickerRef.current);
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    tickerRef.current = null;
    stopTimerRef.current = null;
  }, []);

  const releasePreview = useCallback(() => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    setPreview(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      recorderRef.current = null;
      stopTracks();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
      previewRef.current = null;
    };
  }, [clearTimers, stopTracks]);

  const stopRecording = useCallback(() => {
    clearTimers();
    setElapsedMs(Math.min(MAX_DURATION_MS, Date.now() - startedAtRef.current));
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    else stopTracks();
  }, [clearTimers, stopTracks]);

  const startRecording = async () => {
    setError("");
    releasePreview();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前环境不支持录音，请使用新版浏览器或 Electron 客户端");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredVoiceMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setPhase("recording");

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        clearTimers();
        stopTracks();
        if (!mountedRef.current) return;
        setError("录音过程中发生错误，请重新录制");
        setPhase("idle");
      };
      recorder.onstop = () => {
        clearTimers();
        stopTracks();
        const durationSeconds = Math.max(
          1,
          Math.min(60, Math.ceil((Date.now() - startedAtRef.current) / 1_000)),
        );
        const resolvedType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: resolvedType });
        recorderRef.current = null;
        if (!mountedRef.current) return;
        if (blob.size === 0) {
          setError("没有录到声音，请重新尝试");
          setPhase("idle");
          return;
        }
        if (blob.size > MAX_AUDIO_BYTES) {
          setError("语音文件超过 8 MB，请缩短录制时间");
          setPhase("idle");
          return;
        }
        const nextPreview = {
          blob,
          url: URL.createObjectURL(blob),
          durationSeconds,
          mimeType: resolvedType,
        };
        previewRef.current = nextPreview;
        setPreview(nextPreview);
        setElapsedMs(durationSeconds * 1_000);
        setPhase("preview");
      };

      recorder.start(250);
      tickerRef.current = window.setInterval(
        () => setElapsedMs(Math.min(MAX_DURATION_MS, Date.now() - startedAtRef.current)),
        100,
      );
      stopTimerRef.current = window.setTimeout(stopRecording, MAX_DURATION_MS);
    } catch (caught) {
      stopTracks();
      if (!mountedRef.current) return;
      setPhase("idle");
      setError(voiceErrorMessage(caught));
    }
  };

  const sendVoice = async () => {
    if (!preview || sending) return;
    setSending(true);
    setError("");
    const extension = preview.mimeType.includes("mp4") ? "m4a" : "webm";
    const file = new File(
      [preview.blob],
      `语音明信片-${preview.durationSeconds}秒-${Date.now()}.${extension}`,
      { type: preview.mimeType },
    );
    try {
      if (await onSend(file, preview.durationSeconds)) onDismiss();
      else setError("语音发送失败，录音仍保留在这里，可以再次发送");
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const dismiss = () => {
    if (sending) return;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    clearTimers();
    stopTracks();
    releasePreview();
    onDismiss();
  };

  return createPortal(
    <div
      className="dialog-layer voice-recorder-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && phase !== "recording") dismiss();
      }}
    >
      <section
        className="voice-recorder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-recorder-title"
      >
        <header>
          <span className="dialog-symbol">
            <Mic2 size={20} />
          </span>
          <div>
            <strong id="voice-recorder-title">语音明信片</strong>
            <small>录一段不超过 60 秒的声音给 {peerName}</small>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={phase === "recording" || sending}
            aria-label="关闭语音录制"
          >
            <X size={18} />
          </button>
        </header>

        <div className={`voice-recorder-stage is-${phase}`}>
          <span className="voice-recorder-orb">
            <Mic2 size={26} />
          </span>
          <div className="voice-live-wave" aria-hidden="true">
            {[8, 16, 25, 13, 30, 19, 10, 22, 28, 15, 24, 11].map((height, index) => (
              <i key={`${height}-${index}`} style={{ height }} />
            ))}
          </div>
          <strong>
            {phase === "idle"
              ? "准备好后开始录制"
              : phase === "recording"
                ? "正在聆听"
                : "试听后再发送"}
          </strong>
          <time aria-live="polite">{formatRecorderTime(elapsedMs)} / 1:00</time>
          {phase === "preview" && preview && (
            <audio className="voice-preview-player" controls preload="metadata" src={preview.url}>
              你的浏览器不支持音频试听。
            </audio>
          )}
          <small className="voice-privacy-note">
            录音先保留在本机，确认发送后才上传到团队的 MinIO。
          </small>
        </div>

        {error && <p className="dialog-error voice-recorder-error">{error}</p>}
        <footer>
          {phase === "idle" && (
            <button
              type="button"
              className="voice-record-button"
              onClick={() => void startRecording()}
            >
              <Mic2 size={16} /> 开始录制
            </button>
          )}
          {phase === "recording" && (
            <button type="button" className="voice-stop-button" onClick={stopRecording}>
              <Square size={15} fill="currentColor" /> 停止录制
            </button>
          )}
          {phase === "preview" && preview && (
            <>
              <button
                type="button"
                className="dialog-cancel"
                onClick={() => {
                  releasePreview();
                  setElapsedMs(0);
                  setPhase("idle");
                  setError("");
                }}
                disabled={sending}
              >
                <RotateCcw size={14} /> 重录
              </button>
              <span className="voice-preview-size">{formatBytes(preview.blob.size)}</span>
              <button
                type="button"
                className="dialog-primary"
                onClick={() => void sendVoice()}
                disabled={sending}
              >
                {sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
                发送语音
              </button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
