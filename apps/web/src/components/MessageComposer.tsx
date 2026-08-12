import { FileText, LoaderCircle, Paperclip, Reply, Send, X } from "lucide-react";
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, useEffect, useRef } from "react";
import type { Attachment, Message } from "../types";
import { formatBytes } from "../utils/format";
import { messageSummary } from "../utils/message";

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
  replyingTo: Message | null;
  onTextChange: (value: string) => void;
  onChooseFile: (file: File | undefined) => void;
  onRemoveAttachment: () => void;
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
  replyingTo,
  onTextChange,
  onChooseFile,
  onRemoveAttachment,
  onSend,
  onCancelReply,
}: MessageComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const canSend = !sending && !upload && Boolean(text.trim() || pendingAttachment);

  return (
    <form className="composer-wrap" onSubmit={submit}>
      <div className="composer">
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

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={`发消息给 ${peerName}`}
          rows={1}
          maxLength={5_000}
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
              disabled={uploadBlocked}
              aria-label="添加图片或附件"
              title="添加图片或附件"
            >
              <Paperclip size={19} />
            </button>
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
  );
}
