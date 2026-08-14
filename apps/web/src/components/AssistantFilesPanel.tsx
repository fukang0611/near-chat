import {
  Check,
  Download,
  FileImage,
  FileText,
  Files,
  FolderInput,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AiAssistant, AiAssistantFile, ChatFileItem } from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";

interface AssistantFilesPanelProps {
  assistant: AiAssistant;
  files: AiAssistantFile[];
  loading: boolean;
  onFileAdded: (file: AiAssistantFile) => void;
  onFileRemoved: (fileId: string) => void;
  onNotice: (tone: "error" | "success", text: string) => void;
}

const ORIGIN_LABELS = {
  CHAT: "聊天引用",
  UPLOAD: "单独上传",
  GENERATED: "助理生成",
} as const;

function fileIcon(file: AiAssistantFile | ChatFileItem) {
  const attachment = file.attachment;
  return attachment.contentType.startsWith("image/") ? (
    <FileImage size={20} />
  ) : (
    <FileText size={20} />
  );
}

/** 文件下载始终由用户显式触发，不会因打开工作区或预览列表自动开始。 */
async function downloadAttachment(attachment: AiAssistantFile["attachment"]): Promise<void> {
  const blob = await api.fileBlob(attachment.id, true);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.originalName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * 助理文件工作区只维护附件引用。聊天来源不会复制 MinIO 对象；单独上传在绑定失败时
 * 会主动回收，避免用户看不到却持续占用配额。
 */
export function AssistantFilesPanel({
  assistant,
  files,
  loading,
  onFileAdded,
  onFileRemoved,
  onNotice,
}: AssistantFilesPanelProps) {
  const [keyword, setKeyword] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [chatKeyword, setChatKeyword] = useState("");
  const [chatFiles, setChatFiles] = useState<ChatFileItem[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [addingAttachmentId, setAddingAttachmentId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const visibleFiles = useMemo(() => {
    const normalized = keyword.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return files;
    return files.filter((file) =>
      file.attachment.originalName.toLocaleLowerCase("zh-CN").includes(normalized),
    );
  }, [files, keyword]);

  const existingAttachments = useMemo(
    () => new Set(files.map((file) => file.attachment.id)),
    [files],
  );

  useEffect(() => {
    if (!importOpen) return;
    let active = true;
    const timer = window.setTimeout(
      () => {
        setChatLoading(true);
        void api
          .chatFiles({ keyword: chatKeyword.trim() || undefined, limit: 200 })
          .then((page) => {
            if (active) setChatFiles(page.files);
          })
          .catch((error) => {
            if (active) onNotice("error", errorMessage(error, "聊天文件加载失败"));
          })
          .finally(() => {
            if (active) setChatLoading(false);
          });
      },
      chatKeyword ? 220 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [chatKeyword, importOpen, onNotice]);

  useEffect(() => {
    if (!importOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setImportOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [importOpen]);

  const addChatFile = async (item: ChatFileItem) => {
    if (addingAttachmentId || existingAttachments.has(item.attachment.id)) return;
    setAddingAttachmentId(item.attachment.id);
    try {
      const result = await api.addAiAssistantFile(assistant.id, item.attachment.id, "CHAT");
      onFileAdded(result.file);
      onNotice("success", `“${item.attachment.originalName}”已加入文件工作区`);
    } catch (error) {
      onNotice("error", errorMessage(error, "聊天文件添加失败"));
    } finally {
      setAddingAttachmentId(null);
    }
  };

  const uploadFile = async (file: File) => {
    if (uploadProgress !== null) return;
    setUploadProgress(0);
    let attachmentId: string | null = null;
    try {
      const attachment = await api.upload(file, setUploadProgress);
      attachmentId = attachment.id;
      const result = await api.addAiAssistantFile(assistant.id, attachment.id, "UPLOAD");
      onFileAdded(result.file);
      onNotice("success", `“${attachment.originalName}”已上传`);
    } catch (error) {
      if (attachmentId) await api.deleteFile(attachmentId).catch(() => undefined);
      onNotice("error", errorMessage(error, "文件上传失败"));
    } finally {
      setUploadProgress(null);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const removeFile = async (file: AiAssistantFile) => {
    if (removingId) return;
    setRemovingId(file.id);
    try {
      await api.deleteAiAssistantFile(assistant.id, file.id);
      onFileRemoved(file.id);
      setConfirmRemoveId(null);
      onNotice("success", "已从助理文件工作区移除");
    } catch (error) {
      onNotice("error", errorMessage(error, "文件移除失败"));
    } finally {
      setRemovingId(null);
    }
  };

  const download = async (file: AiAssistantFile) => {
    try {
      await downloadAttachment(file.attachment);
    } catch (error) {
      onNotice("error", errorMessage(error, "文件下载失败"));
    }
  };

  return (
    <section className="assistant-files-panel" aria-label={`${assistant.name} 的文件工作区`}>
      <header className="assistant-files-toolbar">
        <div>
          <span className="assistant-files-mark">
            <Files size={20} />
          </span>
          <span>
            <strong>文件工作区</strong>
            <small>{files.length} / 30 个文件 · 文档可在提问时按需引用</small>
          </span>
        </div>
        <div>
          <button type="button" onClick={() => setImportOpen(true)}>
            <FolderInput size={15} />
            从聊天添加
          </button>
          <button type="button" className="is-primary" onClick={() => uploadRef.current?.click()}>
            {uploadProgress === null ? (
              <Upload size={15} />
            ) : (
              <LoaderCircle className="spin" size={15} />
            )}
            {uploadProgress === null ? "上传文件" : `${uploadProgress}%`}
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadFile(file);
            }}
          />
        </div>
      </header>

      <div className="assistant-files-search">
        <Search size={15} />
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索工作区文件"
          aria-label="搜索助理文件"
        />
        {keyword && (
          <button type="button" onClick={() => setKeyword("")} aria-label="清除文件搜索">
            <X size={13} />
          </button>
        )}
      </div>

      <div className="assistant-files-list">
        {loading ? (
          <div className="assistant-files-state">
            <LoaderCircle className="spin" size={22} />
            正在读取文件工作区
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="assistant-files-empty">
            <span>
              <Files size={25} />
            </span>
            <strong>{keyword ? "没有匹配的文件" : "给助理准备一些工作资料"}</strong>
            <p>
              {keyword
                ? "换个关键词试试"
                : "可复用聊天里的文件，也可为这个助理单独上传；文件不会被自动读取。"}
            </p>
            {!keyword && (
              <div>
                <button type="button" onClick={() => setImportOpen(true)}>
                  <FolderInput size={15} /> 从聊天添加
                </button>
                <button type="button" onClick={() => uploadRef.current?.click()}>
                  <Upload size={15} /> 上传文件
                </button>
              </div>
            )}
          </div>
        ) : (
          visibleFiles.map((file) => (
            <article className="assistant-file-card" key={file.id}>
              <span className="assistant-file-icon">{fileIcon(file)}</span>
              <div>
                <strong title={file.attachment.originalName}>{file.attachment.originalName}</strong>
                <small>
                  {formatBytes(file.attachment.sizeBytes)} · {ORIGIN_LABELS[file.origin]} ·{" "}
                  {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(
                    new Date(file.createdAt),
                  )}
                </small>
              </div>
              <span className={`assistant-file-capability ${file.processable ? "is-ready" : ""}`}>
                {file.processable ? <Check size={11} /> : null}
                {file.processable ? "可交给助理阅读" : "仅保存与下载"}
              </span>
              <div className="assistant-file-actions">
                <button
                  type="button"
                  onClick={() => void download(file)}
                  aria-label={`下载 ${file.attachment.originalName}`}
                >
                  <Download size={15} />
                </button>
                {confirmRemoveId === file.id ? (
                  <span className="assistant-file-remove-confirm">
                    <button type="button" onClick={() => setConfirmRemoveId(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeFile(file)}
                      disabled={removingId === file.id}
                    >
                      {removingId === file.id ? (
                        <LoaderCircle className="spin" size={12} />
                      ) : (
                        "移除"
                      )}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(file.id)}
                    aria-label={`移除 ${file.attachment.originalName}`}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {importOpen && (
        <div
          className="assistant-file-import-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setImportOpen(false);
          }}
        >
          <section role="dialog" aria-modal="true" aria-label="从聊天添加文件">
            <header>
              <span>
                <FolderInput size={19} />
                <span>
                  <strong>从聊天添加</strong>
                  <small>只显示你仍有权限访问的会话文件</small>
                </span>
              </span>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                aria-label="关闭聊天文件选择器"
              >
                <X size={16} />
              </button>
            </header>
            <label>
              <Search size={15} />
              <input
                value={chatKeyword}
                onChange={(event) => setChatKeyword(event.target.value)}
                placeholder="按文件名搜索"
                autoFocus
              />
            </label>
            <div className="assistant-file-import-list">
              {chatLoading ? (
                <div className="assistant-files-state">
                  <LoaderCircle className="spin" size={20} /> 正在加载
                </div>
              ) : chatFiles.length === 0 ? (
                <div className="assistant-files-state">
                  <Files size={21} /> 暂无可用聊天文件
                </div>
              ) : (
                chatFiles.map((item) => {
                  const added = existingAttachments.has(item.attachment.id);
                  const adding = addingAttachmentId === item.attachment.id;
                  return (
                    <article key={`${item.messageId}-${item.attachment.id}`}>
                      <span className="assistant-file-icon">{fileIcon(item)}</span>
                      <div>
                        <strong title={item.attachment.originalName}>
                          {item.attachment.originalName}
                        </strong>
                        <small>
                          {item.senderName} · {formatBytes(item.attachment.sizeBytes)}
                        </small>
                      </div>
                      <button
                        type="button"
                        disabled={added || Boolean(addingAttachmentId)}
                        onClick={() => void addChatFile(item)}
                      >
                        {adding ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : added ? (
                          <Check size={14} />
                        ) : (
                          <Plus size={14} />
                        )}
                        {added ? "已添加" : "添加"}
                      </button>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
