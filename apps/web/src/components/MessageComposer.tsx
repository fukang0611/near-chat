import {
  AtSign,
  FileText,
  Laugh,
  LoaderCircle,
  Mic2,
  Paperclip,
  Reply,
  Send,
  Sparkles,
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
  useMemo,
  useRef,
  useState,
} from "react";
import type { AiAssistant, Attachment, Message } from "../types";
import { assistantMentionPrompt, removeAssistantMention } from "../utils/assistant-mention";
import { formatBytes } from "../utils/format";
import { MAX_MESSAGE_TEXT_LENGTH, messageSummary } from "../utils/message";
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
  assistants?: AiAssistant[];
  assistantMention?: AiAssistant | null;
  onTextChange: (value: string) => void;
  onChooseFile: (file: File | undefined) => void;
  onRemoveAttachment: () => void;
  onSendVoice: (file: File, durationSeconds: number) => Promise<boolean>;
  onSend: () => void;
  onCancelReply: () => void;
  onAssistantMentionChange?: (assistant: AiAssistant | null) => void;
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
  assistants = [],
  assistantMention = null,
  onTextChange,
  onChooseFile,
  onRemoveAttachment,
  onSendVoice,
  onSend,
  onCancelReply,
  onAssistantMentionChange,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const emojiAnchorRef = useRef<HTMLDivElement>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [mentionMenu, setMentionMenu] = useState<{
    start: number;
    end: number;
    query: string;
    value: string;
  } | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
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

  useEffect(() => {
    if (!mentionMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setMentionMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMentionMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mentionMenu]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    onSend();
  };

  const matchingAssistants = useMemo(() => {
    const query = mentionMenu?.query.trim().toLocaleLowerCase() ?? "";
    return assistants
      .filter(
        (assistant) =>
          !query ||
          assistant.name.toLocaleLowerCase().includes(query) ||
          assistant.description.toLocaleLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [assistants, mentionMenu?.query]);

  const selectAssistantMention = (assistant: AiAssistant) => {
    if (!mentionMenu) return;
    const nextText = `${mentionMenu.value.slice(0, mentionMenu.start)}@${assistant.name} ${mentionMenu.value.slice(
      mentionMenu.end,
    )}`;
    const nextPosition = mentionMenu.start + assistant.name.length + 2;
    onTextChange(nextText);
    onAssistantMentionChange?.(assistant);
    setMentionMenu(null);
    selectionRef.current = { start: nextPosition, end: nextPosition };
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPosition, nextPosition);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    if (mentionMenu && matchingAssistants.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setMentionActiveIndex(
          (current) =>
            (current + direction + matchingAssistants.length) % matchingAssistants.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectAssistantMention(matchingAssistants[mentionActiveIndex] ?? matchingAssistants[0]!);
        return;
      }
    }
    if (mentionMenu && event.key === "Escape") {
      event.preventDefault();
      setMentionMenu(null);
      return;
    }
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

  const canSend =
    !disabled &&
    !sending &&
    !upload &&
    Boolean(text.trim() || pendingAttachment) &&
    (!assistantMention || Boolean(assistantMentionPrompt(text, assistantMention.name)));

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
    if (nextText.length > MAX_MESSAGE_TEXT_LENGTH) return;

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

  const updateText = (value: string, caret: number) => {
    onTextChange(value);
    if (assistantMention && !value.includes(`@${assistantMention.name}`)) {
      onAssistantMentionChange?.(null);
    }
    if (assistants.length === 0 || assistantMention) {
      setMentionMenu(null);
      return;
    }
    const beforeCaret = value.slice(0, caret);
    const match = /(?:^|\s)@([^@\n\s]*)$/.exec(beforeCaret);
    if (!match) {
      setMentionMenu(null);
      return;
    }
    const atOffset = match[0].lastIndexOf("@");
    setMentionMenu({
      start: beforeCaret.length - match[0].length + atOffset,
      end: caret,
      query: match[1] ?? "",
      value,
    });
    setMentionActiveIndex(0);
  };

  const openAssistantMenu = () => {
    if (disabled || assistantMention || assistants.length === 0) return;
    // 工具栏按钮同时承担开关职责，面板已经打开时只关闭，不重复写入新的 @ 字符。
    if (mentionMenu) {
      setMentionMenu(null);
      textareaRef.current?.focus();
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s/.test(text[start - 1] ?? "");
    const prefix = needsSpace ? " @" : "@";
    const nextText = `${text.slice(0, start)}${prefix}${text.slice(end)}`;
    const atIndex = start + (needsSpace ? 1 : 0);
    onTextChange(nextText);
    setMentionMenu({ start: atIndex, end: atIndex + 1, query: "", value: nextText });
    setMentionActiveIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(atIndex + 1, atIndex + 1);
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

          {assistantMention && (
            <div className="composer-assistant-mention">
              <span style={{ background: assistantMention.avatarColor }}>
                <AtSign size={13} />
              </span>
              <strong>{assistantMention.name}</strong>
              <small>先生成仅你可见的预览</small>
              <button
                type="button"
                onClick={() => {
                  onTextChange(removeAssistantMention(text, assistantMention.name));
                  onAssistantMentionChange?.(null);
                }}
                aria-label={`移除助理 ${assistantMention.name}`}
              >
                <X size={13} />
              </button>
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
            onChange={(event) => updateText(event.target.value, event.target.selectionStart)}
            onSelect={rememberSelection}
            onClick={rememberSelection}
            onKeyUp={rememberSelection}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`发消息给 ${peerName}`}
            rows={1}
            maxLength={MAX_MESSAGE_TEXT_LENGTH}
            disabled={disabled}
          />

          {mentionMenu && (
            <div className="assistant-mention-menu" role="listbox" aria-label="选择智能助理">
              <header>
                <Sparkles size={13} />
                选择个人助理
                <span>结果先私下预览</span>
              </header>
              {matchingAssistants.length > 0 ? (
                matchingAssistants.map((assistant, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mentionActiveIndex}
                    className={index === mentionActiveIndex ? "is-active" : ""}
                    key={assistant.id}
                    onPointerEnter={() => setMentionActiveIndex(index)}
                    onClick={() => selectAssistantMention(assistant)}
                  >
                    <i style={{ background: assistant.avatarColor }}>
                      <Sparkles size={13} />
                    </i>
                    <span>
                      <strong>{assistant.name}</strong>
                      <small>{assistant.description || "个人智能助理"}</small>
                    </span>
                  </button>
                ))
              ) : (
                <p>没有匹配的助理</p>
              )}
            </div>
          )}

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
              {assistants.length > 0 && (
                <button
                  type="button"
                  onClick={openAssistantMenu}
                  disabled={disabled || Boolean(assistantMention)}
                  aria-label="提及智能助理"
                  title={assistantMention ? "一次消息只能提及一个助理" : "@ 智能助理"}
                >
                  <AtSign size={18} />
                </button>
              )}
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
              <span>支持粘贴或拖入文件 · 最大 500 MB</span>
            </div>
            <div className="send-group">
              {text.length > MAX_MESSAGE_TEXT_LENGTH - 500 && (
                <small>
                  {text.length}/{MAX_MESSAGE_TEXT_LENGTH}
                </small>
              )}
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
