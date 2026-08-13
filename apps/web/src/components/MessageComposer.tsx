import {
  FileText,
  Laugh,
  LoaderCircle,
  Mic2,
  Paperclip,
  Reply,
  Send,
  TimerOff,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Attachment, Message } from "../types";
import { formatBytes } from "../utils/format";
import { messageSummary } from "../utils/message";
import { EmojiPicker } from "./EmojiPicker";
import { VoicePostcardRecorder } from "./VoicePostcardRecorder";

const EMOJI_PICKER_WIDTH = 354;
const EMOJI_PICKER_GAP = 10;
const EMOJI_PICKER_VIEWPORT_MARGIN = 12;

export interface UploadProgress {
  name: string;
  progress: number;
}

interface MessageComposerProps {
  peerName: string;
  text: string;
  pendingAttachment: Attachment | null;
  upload: UploadProgress | null;
  uploadBlocked: boolean;
  sending: boolean;
  disabled?: boolean;
  disabledReason?: string;
  replyingTo: Message | null;
  onTextChange: (value: string) => void;
  onChooseFile: (file: File | undefined) => void;
  onRemoveAttachment: () => void;
  onSendVoice: (file: File, durationSeconds: number) => Promise<boolean>;
  onSend: () => void;
  onCancelReply: () => void;
}

/**
 * 消息编辑器封装输入法、粘贴文件、文件选择和自适应高度等浏览器细节。
 * 页面只接收最终文本、文件和发送意图。
 */
export function MessageComposer({
  peerName,
  text,
  pendingAttachment,
  upload,
  uploadBlocked,
  sending,
  disabled = false,
  disabledReason = "当前会话暂时无法发送消息",
  replyingTo,
  onTextChange,
  onChooseFile,
  onRemoveAttachment,
  onSendVoice,
  onSend,
  onCancelReply,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const emojiAnchorRef = useRef<HTMLDivElement>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const selectionRef = useRef({ start: text.length, end: text.length });

  const closeEmojiPicker = useCallback(() => setShowEmojiPicker(false), []);

  const updateEmojiPickerPosition = useCallback(() => {
    const composer = composerRef.current;
    const anchor = emojiAnchorRef.current;
    if (!composer || !anchor) return;

    const composerRect = composer.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maximumLeft = Math.max(
      EMOJI_PICKER_VIEWPORT_MARGIN,
      viewportWidth - EMOJI_PICKER_VIEWPORT_MARGIN - EMOJI_PICKER_WIDTH,
    );
    const clampedLeft = Math.min(
      Math.max(anchorRect.left, EMOJI_PICKER_VIEWPORT_MARGIN),
      maximumLeft,
    );

    // 桌面端相对按钮定位，移动端相对视口定位；两者都以完整输入器顶部为下边界。
    anchor.style.setProperty(
      "--emoji-picker-offset",
      `${Math.round(anchorRect.bottom - composerRect.top + EMOJI_PICKER_GAP)}px`,
    );
    anchor.style.setProperty(
      "--emoji-picker-viewport-bottom",
      `${Math.round(viewportHeight - composerRect.top + EMOJI_PICKER_GAP)}px`,
    );
    anchor.style.setProperty(
      "--emoji-picker-max-height",
      `${Math.max(
        160,
        Math.floor(composerRect.top - EMOJI_PICKER_GAP - EMOJI_PICKER_VIEWPORT_MARGIN),
      )}px`,
    );
    anchor.style.setProperty(
      "--emoji-picker-shift-x",
      `${Math.round(clampedLeft - anchorRect.left)}px`,
    );
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  useLayoutEffect(() => {
    if (!showEmojiPicker) return;

    updateEmojiPickerPosition();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateEmojiPickerPosition);
    if (composerRef.current) resizeObserver?.observe(composerRef.current);
    window.addEventListener("resize", updateEmojiPickerPosition);
    window.visualViewport?.addEventListener("resize", updateEmojiPickerPosition);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateEmojiPickerPosition);
      window.visualViewport?.removeEventListener("resize", updateEmojiPickerPosition);
    };
  }, [showEmojiPicker, updateEmojiPickerPosition]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const closeOutside = (event: PointerEvent) => {
      if (!emojiAnchorRef.current?.contains(event.target as Node)) closeEmojiPicker();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [closeEmojiPicker, showEmojiPicker]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = event.clipboardData.files[0];
    if (!file) return;
    event.preventDefault();
    onChooseFile(file);
  };

  const canSend = !disabled && !sending && !upload && Boolean(text.trim() || pendingAttachment);

  const rememberSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart ?? text.length,
      end: textarea.selectionEnd ?? text.length,
    };
  };

  const toggleEmojiPicker = () => {
    if (!showEmojiPicker) rememberSelection();
    if (!disabled) setShowEmojiPicker((current) => !current);
  };

  const insertEmoji = (emoji: string) => {
    const { start, end } = selectionRef.current;
    // 外部切换会话或清空草稿后，旧光标位置可能超过新文本长度，先收敛到有效范围。
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.min(Math.max(end, safeStart), text.length);
    const nextText = `${text.slice(0, safeStart)}${emoji}${text.slice(safeEnd)}`;

    // 与 textarea 的 maxLength 保持一致；空间不足时不截断 Emoji，避免产生半个代理字符。
    if (nextText.length > 5_000) return;

    const nextPosition = safeStart + emoji.length;
    selectionRef.current = { start: nextPosition, end: nextPosition };
    onTextChange(nextText);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextPosition, nextPosition);
    });
  };

  return (
    <>
      <form className="composer-wrap" onSubmit={submit}>
        <div className={`composer ${disabled ? "is-locked" : ""}`} ref={composerRef}>
          {replyingTo && (
            <div className="composer-reply">
              <span className="composer-reply-icon">
                <Reply size={15} />
              </span>
              <span>
                <small>回复 {replyingTo.senderName}</small>
                <strong>{messageSummary(replyingTo)}</strong>
              </span>
              <button type="button" onClick={onCancelReply} aria-label="取消回复">
                <X size={15} />
              </button>
            </div>
          )}
          {pendingAttachment && (
            <div className="pending-file">
              <span className="pending-file-icon">
                <FileText size={17} />
              </span>
              <span>
                <strong>{pendingAttachment.originalName}</strong>
                <small>{formatBytes(pendingAttachment.sizeBytes)} · 已准备发送</small>
              </span>
              <button type="button" onClick={onRemoveAttachment} aria-label="移除附件">
                <X size={15} />
              </button>
            </div>
          )}

          {upload && (
            <div
              className="pending-file is-uploading"
              role="progressbar"
              aria-label={`正在上传 ${upload.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={upload.progress}
            >
              <span className="pending-file-icon">
                <LoaderCircle className="spin" size={17} />
              </span>
              <span>
                <strong>{upload.name}</strong>
                <small>正在上传 · {upload.progress}%</small>
                <i>
                  <b style={{ width: `${upload.progress}%` }} />
                </i>
              </span>
            </div>
          )}

          {disabled && (
            <div className="composer-lock-note" role="status">
              <TimerOff size={16} />
              <span>
                <strong>闪聊已经结束</strong>
                <small>{disabledReason}</small>
              </span>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            onSelect={rememberSelection}
            onClick={rememberSelection}
            onKeyUp={rememberSelection}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`发消息给 ${peerName}`}
            rows={1}
            maxLength={5_000}
            disabled={disabled}
          />

          <div className="composer-actions">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(event) => {
                  onChooseFile(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBlocked || disabled}
                aria-label="添加图片或附件"
                title="添加图片或附件"
              >
                <Paperclip size={19} />
              </button>
              <button
                type="button"
                onClick={() => setShowVoiceRecorder(true)}
                disabled={uploadBlocked || disabled}
                aria-label="录制语音明信片"
                title="语音明信片"
              >
                <Mic2 size={18} />
              </button>
              <div className="emoji-picker-anchor" ref={emojiAnchorRef}>
                <button
                  type="button"
                  onClick={toggleEmojiPicker}
                  aria-label="选择表情"
                  title="选择表情"
                  aria-expanded={showEmojiPicker}
                  aria-haspopup="dialog"
                  disabled={disabled}
                >
                  <Laugh size={19} />
                </button>
                {showEmojiPicker && (
                  <>
                    <button
                      className="emoji-mobile-scrim"
                      type="button"
                      onClick={closeEmojiPicker}
                      aria-label="关闭表情面板"
                    />
                    <EmojiPicker onSelect={insertEmoji} onClose={closeEmojiPicker} />
                  </>
                )}
              </div>
              <span>支持粘贴或拖入文件 · 最大 50 MB</span>
            </div>
            <div className="send-group">
              {text.length > 4_500 && <small>{text.length}/5000</small>}
              <span className="keyboard-hint">Enter 发送</span>
              <button
                className="send-button"
                type="submit"
                disabled={!canSend}
                aria-label="发送消息"
                title="发送消息"
              >
                {sending ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
              </button>
            </div>
          </div>
        </div>
      </form>
      {showVoiceRecorder && (
        <VoicePostcardRecorder
          peerName={peerName}
          onDismiss={() => setShowVoiceRecorder(false)}
          onSend={onSendVoice}
        />
      )}
    </>
  );
}
