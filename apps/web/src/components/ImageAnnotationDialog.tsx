import {
  ArrowUpRight,
  Eraser,
  LoaderCircle,
  MousePointer2,
  PenLine,
  Redo2,
  Send,
  Square,
  Undo2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../types";
import {
  annotationCanvasSize,
  annotationDistance,
  drawAnnotationStrokes,
  type AnnotationPoint,
  type AnnotationStroke,
} from "../utils/image-annotation";

type AnnotationTool = "rect" | "arrow" | "pen";

interface ImageAnnotationDialogProps {
  attachment: Attachment;
  imageUrl: string;
  onDismiss: () => void;
  onSend: (file: File) => Promise<boolean>;
}

const ANNOTATION_COLORS = ["#ff4f63", "#ffb32c", "#35c894", "#765ff2"];
const MAX_FILE_BYTES = 500 * 1024 * 1024;

function pointFromPointer(
  event: ReactPointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
): AnnotationPoint {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * canvas.width,
    y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * canvas.height,
  };
}

function startStroke(
  tool: AnnotationTool,
  color: string,
  point: AnnotationPoint,
): AnnotationStroke {
  return tool === "pen"
    ? { kind: "pen", color, points: [point] }
    : { kind: tool, color, start: point, end: point };
}

function extendStroke(stroke: AnnotationStroke, point: AnnotationPoint): AnnotationStroke {
  return stroke.kind === "pen"
    ? { ...stroke, points: [...stroke.points, point] }
    : { ...stroke, end: point };
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片生成失败"))),
      "image/png",
    );
  });
}

/** 图片标注始终生成新文件，既不修改 MinIO 原对象，也不影响原消息。 */
export function ImageAnnotationDialog({
  attachment,
  imageUrl,
  onDismiss,
  onSend,
}: ImageAnnotationDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("rect");
  const [color, setColor] = useState(ANNOTATION_COLORS[0]);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<AnnotationStroke[]>([]);
  const [draftStroke, setDraftStroke] = useState<AnnotationStroke | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const repaint = useCallback(
    (includeDraft = true) => {
      const canvas = canvasRef.current;
      const image = imageRef.current;
      if (!canvas || !image) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      drawAnnotationStrokes(
        context,
        includeDraft && draftStroke ? [...strokes, draftStroke] : strokes,
        canvas.width,
        canvas.height,
      );
    },
    [draftStroke, strokes],
  );

  useEffect(() => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const size = annotationCanvasSize(image.naturalWidth, image.naturalHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      imageRef.current = image;
      setReady(true);
      setLoadError("");
    };
    image.onerror = () => setLoadError("无法打开原图，请关闭后重试");
    image.src = imageUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
      imageRef.current = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    if (ready) repaint();
  }, [ready, repaint]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>(".image-annotation-close")?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) onDismiss();
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          setUndoneStrokes((undone) => {
            const stroke = undone.at(-1);
            if (!stroke) return undone;
            setStrokes((current) => [...current, stroke]);
            return undone.slice(0, -1);
          });
        } else {
          setStrokes((current) => {
            const stroke = current.at(-1);
            if (!stroke) return current;
            setUndoneStrokes((undone) => [...undone, stroke]);
            return current.slice(0, -1);
          });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, sending]);

  const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || sending || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftStroke(startStroke(tool, color, pointFromPointer(event, event.currentTarget)));
    setSendError("");
  };

  const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draftStroke || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromPointer(event, event.currentTarget);
    setDraftStroke((current) => (current ? extendStroke(current, point) : null));
  };

  const finishDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draftStroke) return;
    const completed = extendStroke(draftStroke, pointFromPointer(event, event.currentTarget));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraftStroke(null);
    if (annotationDistance(completed) < Math.max(3, event.currentTarget.width * 0.003)) return;
    setStrokes((current) => [...current, completed]);
    setUndoneStrokes([]);
  };

  const undo = () => {
    setStrokes((current) => {
      const stroke = current.at(-1);
      if (!stroke) return current;
      setUndoneStrokes((undone) => [...undone, stroke]);
      return current.slice(0, -1);
    });
  };

  const redo = () => {
    setUndoneStrokes((current) => {
      const stroke = current.at(-1);
      if (!stroke) return current;
      setStrokes((strokes) => [...strokes, stroke]);
      return current.slice(0, -1);
    });
  };

  const submit = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || strokes.length === 0 || sending) return;
    setSending(true);
    setSendError("");
    try {
      // 导出前重绘一次已提交笔迹，确保指针草稿不会进入最终图片。
      repaint(false);
      const blob = await canvasBlob(canvas);
      if (blob.size > MAX_FILE_BYTES) {
        setSendError("标注图片超过 500 MB，请使用较小的原图");
        return;
      }
      const baseName = attachment.originalName.replace(/\.[^.]+$/, "") || "图片";
      const file = new File([blob], `圈图-${baseName}.png`, { type: "image/png" });
      if (await onSend(file)) onDismiss();
      else setSendError("发送失败，请检查网络后重试");
    } catch {
      setSendError("标注图片生成失败，请重试");
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="image-annotation-layer" role="presentation">
      <section
        ref={dialogRef}
        className="image-annotation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-annotation-title"
      >
        <header className="image-annotation-header">
          <span>
            <small>MARKUP REPLY</small>
            <strong id="image-annotation-title">圈图回复</strong>
            <em>{attachment.originalName}</em>
          </span>
          <button
            type="button"
            className="image-annotation-close"
            onClick={onDismiss}
            disabled={sending}
            aria-label="关闭圈图回复"
          >
            <X size={18} />
          </button>
        </header>

        <div className="image-annotation-toolbar" aria-label="标注工具">
          <div role="group" aria-label="画笔类型">
            <button
              type="button"
              className={tool === "rect" ? "is-active" : ""}
              aria-pressed={tool === "rect"}
              onClick={() => setTool("rect")}
            >
              <Square size={15} />
              矩形
            </button>
            <button
              type="button"
              className={tool === "arrow" ? "is-active" : ""}
              aria-pressed={tool === "arrow"}
              onClick={() => setTool("arrow")}
            >
              <ArrowUpRight size={15} />
              箭头
            </button>
            <button
              type="button"
              className={tool === "pen" ? "is-active" : ""}
              aria-pressed={tool === "pen"}
              onClick={() => setTool("pen")}
            >
              <PenLine size={15} />
              画笔
            </button>
          </div>

          <div className="image-annotation-colors" role="radiogroup" aria-label="标注颜色">
            {ANNOTATION_COLORS.map((option) => (
              <button
                type="button"
                role="radio"
                key={option}
                aria-label={`选择颜色 ${option}`}
                aria-checked={color === option}
                className={color === option ? "is-active" : ""}
                style={{ "--annotation-color": option } as CSSProperties}
                onClick={() => setColor(option)}
              />
            ))}
          </div>

          <div className="image-annotation-history">
            <button
              type="button"
              onClick={undo}
              disabled={strokes.length === 0}
              aria-label="撤销标注"
            >
              <Undo2 size={15} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={undoneStrokes.length === 0}
              aria-label="重做标注"
            >
              <Redo2 size={15} />
            </button>
            <button
              type="button"
              onClick={() => {
                setStrokes([]);
                setUndoneStrokes([]);
              }}
              disabled={strokes.length === 0}
              aria-label="清空标注"
            >
              <Eraser size={15} />
            </button>
          </div>
        </div>

        <div className="image-annotation-stage">
          {!ready && !loadError && (
            <span className="image-annotation-loading">
              <LoaderCircle className="spin" size={20} />
              正在准备画布
            </span>
          )}
          {loadError ? (
            <span className="image-annotation-load-error">{loadError}</span>
          ) : (
            <canvas
              ref={canvasRef}
              className={ready ? "is-ready" : ""}
              aria-label="图片标注画布"
              onPointerDown={beginDrawing}
              onPointerMove={continueDrawing}
              onPointerUp={finishDrawing}
              onPointerCancel={() => setDraftStroke(null)}
            />
          )}
          {ready && strokes.length === 0 && !draftStroke && (
            <span className="image-annotation-guide">
              <MousePointer2 size={14} />
              在图片上拖动开始标注
            </span>
          )}
        </div>

        <footer className="image-annotation-footer">
          <span className={sendError ? "has-error" : ""}>
            {sendError || "将生成新图片并引用回复，原图不会改变"}
          </span>
          <button type="button" className="is-secondary" onClick={onDismiss} disabled={sending}>
            取消
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => void submit()}
            disabled={!ready || strokes.length === 0 || sending}
          >
            {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            {sending ? "正在发送" : "发送圈图"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
