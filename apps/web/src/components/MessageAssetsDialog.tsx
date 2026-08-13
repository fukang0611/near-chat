import {
  FileText,
  Files,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  Mic2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { ChatFileCategory, ChatFileItem, Conversation } from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes, formatMessageDay } from "../utils/format";
import { AttachmentView } from "./AttachmentView";

interface MessageAssetsDialogProps {
  conversations: Conversation[];
  onClose: () => void;
  onOpenMessage: (conversationId: string, messageId: string) => void;
}

const fileFilters: Array<{
  value: ChatFileCategory;
  label: string;
  icon: typeof Files;
}> = [
  { value: "ALL", label: "全部", icon: Files },
  { value: "IMAGE", label: "图片", icon: ImageIcon },
  { value: "AUDIO", label: "语音", icon: Mic2 },
  { value: "FILE", label: "附件", icon: FileText },
];

/**
 * 文件管理是跨会话的只读资产视图。列表数据始终由服务端按成员权限返回，
 * 点击原消息才退出弹层并交给聊天页执行跨会话定位。
 */
export function MessageAssetsDialog({
  conversations,
  onClose,
  onOpenMessage,
}: MessageAssetsDialogProps) {
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [category, setCategory] = useState<ChatFileCategory>("ALL");
  const [conversationId, setConversationId] = useState("");
  const [files, setFiles] = useState<ChatFileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const loadFiles = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const page = await api.chatFiles({
        keyword: debouncedKeyword || undefined,
        category,
        conversationId: conversationId || undefined,
        limit: 200,
      });
      if (requestId !== requestIdRef.current) return;
      setFiles(page.files);
      setTotal(page.total);
      setTotalBytes(page.totalBytes);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(errorMessage(loadError, "聊天文件加载失败"));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [category, conversationId, debouncedKeyword]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="message-assets-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="message-assets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-assets-title"
      >
        <header className="message-assets-header">
          <span className="message-assets-mark" aria-hidden="true">
            <FolderOpen size={23} />
          </span>
          <div>
            <small>MESSAGE LIBRARY</small>
            <strong id="message-assets-title">消息资产</strong>
            <p>集中查看团队会话中的图片、语音与附件</p>
          </div>
          <div className="message-assets-summary" aria-label="当前筛选统计">
            <span>
              <Files size={15} />
              <b>{total}</b> 项
            </span>
            <span>
              <HardDrive size={15} />
              {formatBytes(totalBytes)}
            </span>
          </div>
          <button
            type="button"
            className="message-assets-close"
            onClick={onClose}
            aria-label="关闭消息资产"
          >
            <X size={18} />
          </button>
        </header>

        <div className="message-assets-tabs" role="tablist" aria-label="消息资产分类">
          <button type="button" role="tab" aria-selected="true" className="is-active">
            <FolderOpen size={16} />
            聊天文件
          </button>
        </div>

        <div className="message-assets-toolbar">
          <label className="message-assets-search">
            <Search size={16} />
            <input
              ref={inputRef}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索文件名"
              maxLength={100}
              aria-label="搜索聊天文件"
            />
            {keyword && (
              <button type="button" onClick={() => setKeyword("")} aria-label="清除文件搜索">
                <X size={14} />
              </button>
            )}
          </label>
          <label className="message-assets-conversation-filter">
            <span>会话</span>
            <select
              value={conversationId}
              onChange={(event) => setConversationId(event.target.value)}
              aria-label="按会话筛选文件"
            >
              <option value="">全部会话</option>
              {conversations.map((conversation) => (
                <option value={conversation.id} key={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="message-assets-filter" role="group" aria-label="按文件类型筛选">
          {fileFilters.map((filter) => {
            const Icon = filter.icon;
            return (
              <button
                type="button"
                key={filter.value}
                className={category === filter.value ? "is-active" : ""}
                aria-pressed={category === filter.value}
                onClick={() => setCategory(filter.value)}
              >
                <Icon size={15} />
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="message-assets-body">
          {loading ? (
            <div className="message-assets-state" role="status">
              <LoaderCircle className="spin" size={23} />
              <strong>正在整理聊天文件</strong>
              <span>从你有权访问的会话中汇总</span>
            </div>
          ) : error ? (
            <div className="message-assets-state is-error" role="alert">
              <FolderOpen size={24} />
              <strong>文件列表暂时不可用</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void loadFiles()}>
                <RefreshCw size={15} />
                重新加载
              </button>
            </div>
          ) : files.length === 0 ? (
            <div className="message-assets-state">
              <FolderOpen size={25} />
              <strong>{debouncedKeyword ? "没有匹配的文件" : "这里还没有聊天文件"}</strong>
              <span>
                {debouncedKeyword
                  ? "换个文件名或筛选条件试试"
                  : "发送的图片、语音和附件会集中出现在这里"}
              </span>
            </div>
          ) : (
            <div className="message-assets-grid">
              {files.map((item) => {
                const conversation = conversationById.get(item.conversationId);
                return (
                  <article
                    className="message-asset-card"
                    key={`${item.messageId}:${item.attachment.id}`}
                  >
                    <div className="message-asset-preview">
                      <AttachmentView attachment={item.attachment} />
                    </div>
                    <div className="message-asset-meta">
                      <div>
                        <strong>{item.attachment.originalName}</strong>
                        <small>
                          {formatBytes(item.attachment.sizeBytes)} · {item.senderName}
                        </small>
                      </div>
                      {item.messageText && <p>{item.messageText}</p>}
                      <footer>
                        <span>{conversation?.title ?? "会话"}</span>
                        <time dateTime={item.createdAt}>{formatMessageDay(item.createdAt)}</time>
                        <button
                          type="button"
                          onClick={() => onOpenMessage(item.conversationId, item.messageId)}
                          aria-label={`定位 ${item.attachment.originalName} 的原消息`}
                          title="定位原消息"
                        >
                          <MapPin size={15} />
                          原消息
                        </button>
                      </footer>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
