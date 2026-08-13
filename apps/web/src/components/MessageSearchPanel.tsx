import { FileText, Image, LoaderCircle, MessageSquareText, Mic2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Conversation, Message } from "../types";
import { errorMessage } from "../utils/errors";
import { formatMessageDay } from "../utils/format";

interface MessageSearchPanelProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  onClose: () => void;
  onOpenResult: (conversationId: string, messageId: string) => void;
}

function resultPreview(message: Message): string {
  if (message.textContent) return message.textContent;
  if (message.type === "AUDIO") return "语音明信片";
  return (
    message.attachments[0]?.originalName ?? (message.type === "IMAGE" ? "图片消息" : "附件消息")
  );
}

/** 服务端搜索结果面板；搜索范围由成员权限约束，不在浏览器缓存中做不完整过滤。 */
export function MessageSearchPanel({
  conversations,
  selectedConversationId,
  onClose,
  onOpenResult,
}: MessageSearchPanelProps) {
  const [keyword, setKeyword] = useState("");
  const [currentOnly, setCurrentOnly] = useState(false);
  const [results, setResults] = useState<Message[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const search = async () => {
    const normalized = keyword.trim();
    if (!normalized) return;
    setLoading(true);
    setError("");
    try {
      const result = await api.searchMessages(
        normalized,
        currentOnly && selectedConversationId ? selectedConversationId : undefined,
      );
      setResults(result.messages);
      setSearched(true);
    } catch (searchError) {
      setError(errorMessage(searchError, "消息搜索失败"));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="search-panel-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="message-search-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong id="message-search-title">搜索消息</strong>
            <small>支持消息正文和附件名称</small>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭消息搜索">
            <X size={18} />
          </button>
        </header>

        <form
          className="message-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Search size={17} />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            maxLength={100}
            placeholder="输入消息内容或附件名"
            aria-label="消息关键词"
          />
          {keyword && (
            <button
              type="button"
              className="search-clear"
              onClick={() => {
                setKeyword("");
                setResults([]);
                setSearched(false);
              }}
              aria-label="清除关键词"
            >
              <X size={14} />
            </button>
          )}
          <button type="submit" className="search-submit" disabled={loading || !keyword.trim()}>
            {loading ? <LoaderCircle className="spin" size={15} /> : "搜索"}
          </button>
        </form>

        {selectedConversationId && (
          <label className="search-scope">
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(event) => setCurrentOnly(event.target.checked)}
            />
            仅搜索当前会话
          </label>
        )}

        <div className="message-search-results">
          {error ? (
            <div className="search-result-empty">
              <strong>搜索暂不可用</strong>
              <span>{error}</span>
            </div>
          ) : !searched ? (
            <div className="search-result-empty">
              <Search size={23} />
              <strong>查找过去的消息</strong>
              <span>输入关键词后按回车开始搜索</span>
            </div>
          ) : results.length === 0 ? (
            <div className="search-result-empty">
              <MessageSquareText size={23} />
              <strong>没有找到相关消息</strong>
              <span>尝试更短或不同的关键词</span>
            </div>
          ) : (
            <>
              <div className="search-result-count">找到 {results.length} 条消息</div>
              {results.map((message) => {
                const conversation = conversationById.get(message.conversationId);
                return (
                  <button
                    type="button"
                    className="message-search-result"
                    key={message.id}
                    onClick={() => onOpenResult(message.conversationId, message.id)}
                  >
                    <span className="search-result-icon">
                      {message.type === "IMAGE" ? (
                        <Image size={16} />
                      ) : message.type === "AUDIO" ? (
                        <Mic2 size={16} />
                      ) : message.type === "FILE" ? (
                        <FileText size={16} />
                      ) : (
                        <MessageSquareText size={16} />
                      )}
                    </span>
                    <span>
                      <span>
                        <strong>{message.senderName}</strong>
                        <small>{conversation?.title ?? "会话"}</small>
                        <time>{formatMessageDay(message.createdAt)}</time>
                      </span>
                      <p>{resultPreview(message)}</p>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
