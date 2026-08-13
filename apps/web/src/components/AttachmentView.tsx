import {
  AlertCircle,
  Download,
  FileText,
  LoaderCircle,
  Maximize2,
  PenLine,
  RotateCcw,
  X,
} from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Attachment } from "../types";
import { formatBytes } from "../utils/format";
import { ImageAnnotationDialog } from "./ImageAnnotationDialog";

interface AttachmentViewProps {
  attachment: Attachment;
  onAnnotate?: (file: File) => Promise<boolean>;
}

/**
 * 下载流程同时服务图片和普通文件：读取受保护 Blob、创建临时链接并及时回收 URL。
 * 视图只需要关心 loading/error/download 三个稳定接口。
 */
function useAttachmentDownload(attachment: Attachment) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const blob = await api.fileBlob(attachment.id, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.originalName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setDownloadError("下载失败，请重试");
    } finally {
      setDownloading(false);
    }
  }, [attachment.id, attachment.originalName, downloading]);

  return { downloading, downloadError, download };
}

interface ImagePreviewProps {
  attachment: Attachment;
  imageUrl: string;
  downloading: boolean;
  downloadError: string;
  restoreFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onDownload: () => void;
  onAnnotate?: () => void;
}

function ImagePreview({
  attachment,
  imageUrl,
  downloading,
  downloadError,
  restoreFocusRef,
  onClose,
  onDownload,
  onAnnotate,
}: ImagePreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      previewRef.current?.querySelector<HTMLButtonElement>(".image-preview-close")?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        previewRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => restoreFocusRef.current?.focus());
    };
  }, [onClose, restoreFocusRef]);

  // Portal 避免预览层被消息行的 transform 和滚动容器裁切。
  return createPortal(
    <div
      ref={previewRef}
      className={`image-preview-layer ${onAnnotate ? "has-annotate" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`预览图片 ${attachment.originalName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="image-preview-close"
        onClick={onClose}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="关闭图片预览"
      >
        <X size={20} />
      </button>
      {onAnnotate && (
        <button
          type="button"
          className="image-preview-annotate"
          onClick={onAnnotate}
          onMouseDown={(event) => event.stopPropagation()}
          aria-label={`圈图回复 ${attachment.originalName}`}
        >
          <PenLine size={18} />
          <span>圈图回复</span>
        </button>
      )}
      <img
        className="image-preview-media"
        src={imageUrl}
        alt={attachment.originalName}
        onMouseDown={(event) => event.stopPropagation()}
      />
      <div className="image-preview-meta" aria-hidden="true">
        <strong>{attachment.originalName}</strong>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </div>
      <button
        type="button"
        className={`image-preview-download ${downloadError ? "has-error" : ""}`}
        onClick={onDownload}
        onMouseDown={(event) => event.stopPropagation()}
        disabled={downloading}
        aria-label={`下载原图 ${attachment.originalName}`}
      >
        {downloading ? (
          <LoaderCircle className="spin" size={18} />
        ) : downloadError ? (
          <AlertCircle size={18} />
        ) : (
          <Download size={18} />
        )}
        <span>{downloading ? "正在准备" : downloadError || "下载原图"}</span>
      </button>
    </div>,
    document.body,
  );
}

function ImageAttachment({ attachment, onAnnotate }: AttachmentViewProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { downloading, downloadError, download } = useAttachmentDownload(attachment);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setLoading(true);
    setImageUrl(null);
    setLoadError("");

    void api
      .fileBlob(attachment.id)
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch(() => active && setLoadError("图片加载失败"))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id, loadKey]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`image-attachment ${loadError ? "has-error" : ""}`}
        onClick={() => {
          if (loadError) setLoadKey((current) => current + 1);
          else if (imageUrl) setPreviewOpen(true);
        }}
        aria-label={
          loadError
            ? `重新加载图片 ${attachment.originalName}`
            : `预览图片 ${attachment.originalName}`
        }
        aria-busy={loading}
      >
        {loading && (
          <span className="image-loading">
            <LoaderCircle className="spin" size={20} />
          </span>
        )}
        {imageUrl && <img src={imageUrl} alt={attachment.originalName} />}
        {loadError ? (
          <span className="image-error">
            <RotateCcw size={18} />
            {loadError}
          </span>
        ) : (
          imageUrl && (
            <span className="image-preview-hint">
              <Maximize2 size={15} />
              点击放大
            </span>
          )
        )}
      </button>

      {previewOpen && imageUrl && (
        <ImagePreview
          attachment={attachment}
          imageUrl={imageUrl}
          downloading={downloading}
          downloadError={downloadError}
          restoreFocusRef={triggerRef}
          onClose={closePreview}
          onDownload={() => void download()}
          onAnnotate={
            onAnnotate
              ? () => {
                  setPreviewOpen(false);
                  setAnnotating(true);
                }
              : undefined
          }
        />
      )}
      {annotating && imageUrl && onAnnotate && (
        <ImageAnnotationDialog
          attachment={attachment}
          imageUrl={imageUrl}
          onDismiss={() => setAnnotating(false)}
          onSend={onAnnotate}
        />
      )}
    </>
  );
}

function FileAttachment({ attachment }: AttachmentViewProps) {
  const { downloading, downloadError, download } = useAttachmentDownload(attachment);

  return (
    <button
      type="button"
      className={`file-attachment ${downloadError ? "has-error" : ""}`}
      onClick={() => void download()}
      aria-busy={downloading}
    >
      <span className="file-icon">
        <FileText size={21} />
      </span>
      <span className="file-copy">
        <strong>{attachment.originalName}</strong>
        <small>{downloadError || `${formatBytes(attachment.sizeBytes)} · 点击下载`}</small>
      </span>
      {downloadError ? (
        <AlertCircle size={18} className="download-icon" />
      ) : downloading ? (
        <LoaderCircle size={18} className="download-icon spin" />
      ) : (
        <Download size={18} className="download-icon" />
      )}
    </button>
  );
}

/** 根据媒体类型选择展示模块，调用方无需了解预览或下载状态。 */
export function AttachmentView({ attachment, onAnnotate }: AttachmentViewProps) {
  return attachment.contentType.startsWith("image/") ? (
    <ImageAttachment attachment={attachment} onAnnotate={onAnnotate} />
  ) : (
    <FileAttachment attachment={attachment} />
  );
}
