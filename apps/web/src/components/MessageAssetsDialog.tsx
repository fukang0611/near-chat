import {
  Bookmark,
  FileText,
  Files,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  Mic2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type {
  ChatFileCategory,
  ChatFileItem,
  Conversation,
  MessageFavorite,
  MessageKind,
} from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes, formatMessageDay } from "../utils/format";
import { AttachmentView } from "./AttachmentView";
import { Avatar } from "./Avatar";

interface MessageAssetsDialogProps {
  conversations: Conversation[];
  onClose: () => void;
  onOpenMessage: (conversationId: string, messageId: string) => void;
  onFavoriteRemoved?: (favorite: MessageFavorite) => void;
}

type AssetTab = "FILES" | "FAVORITES";
type FavoriteCategory = "ALL" | MessageKind;

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

const favoriteFilters: Array<{
  value: FavoriteCategory;
  label: string;
  icon: typeof Files;
}> = [
  { value: "ALL", label: "全部", icon: Bookmark },
  { value: "TEXT", label: "文本", icon: MessageSquareText },
  { value: "IMAGE", label: "图片", icon: ImageIcon },
  { value: "AUDIO", label: "语音", icon: Mic2 },
  { value: "FILE", label: "附件", icon: FileText },
];

function favoriteMatchesKeyword(favorite: MessageFavorite, keyword: string): boolean {
  if (!keyword) return true;
  const normalized = keyword.toLocaleLowerCase("zh-CN");
  return [
    favorite.textContent,
    favorite.sourceSenderName,
    favorite.sourceConversationTitle,
    ...favorite.attachments.map((attachment) => attachment.originalName),
  ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalized));
}

/**
 * 跨会话消息资产中心。聊天文件由服务端按成员权限检索；收藏则展示稳定快照，
 * 即使原消息撤回，附件仍通过当前用户的收藏引用获得最小范围访问权限。
 */
export function MessageAssetsDialog({
  conversations,
  onClose,
  onOpenMessage,
  onFavoriteRemoved,
}: MessageAssetsDialogProps) {
  const [tab, setTab] = useState<AssetTab>("FILES");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [fileCategory, setFileCategory] = useState<ChatFileCategory>("ALL");
  const [favoriteCategory, setFavoriteCategory] = useState<FavoriteCategory>("ALL");
  const [conversationId, setConversationId] = useState("");
  const [files, setFiles] = useState<ChatFileItem[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileTotalBytes, setFileTotalBytes] = useState(0);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState("");
  const [favorites, setFavorites] = useState<MessageFavorite[]>([]);
  const [favoritesAttempted, setFavoritesAttempted] = useState(false);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesError, setFavoritesError] = useState("");
  const [removalCandidateId, setRemovalCandidateId] = useState<string | null>(null);
  const [removingFavoriteId, setRemovingFavoriteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRequestIdRef = useRef(0);
  const favoriteRequestIdRef = useRef(0);

  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const loadFiles = useCallback(async () => {
    const requestId = ++fileRequestIdRef.current;
    setFilesLoading(true);
    setFilesError("");
    try {
      const page = await api.chatFiles({
        keyword: debouncedKeyword || undefined,
        category: fileCategory,
        conversationId: conversationId || undefined,
        limit: 200,
      });
      if (requestId !== fileRequestIdRef.current) return;
      setFiles(page.files);
      setFileTotal(page.total);
      setFileTotalBytes(page.totalBytes);
    } catch (loadError) {
      if (requestId !== fileRequestIdRef.current) return;
      setFilesError(errorMessage(loadError, "聊天文件加载失败"));
    } finally {
      if (requestId === fileRequestIdRef.current) setFilesLoading(false);
    }
  }, [conversationId, debouncedKeyword, fileCategory]);

  const loadFavorites = useCallback(async () => {
    const requestId = ++favoriteRequestIdRef.current;
    setFavoritesAttempted(true);
    setFavoritesLoading(true);
    setFavoritesError("");
    try {
      const result = await api.messageFavorites();
      if (requestId !== favoriteRequestIdRef.current) return;
      setFavorites(result.favorites);
      setFavoritesLoaded(true);
    } catch (loadError) {
      if (requestId !== favoriteRequestIdRef.current) return;
      setFavoritesError(errorMessage(loadError, "收藏加载失败"));
    } finally {
      if (requestId === favoriteRequestIdRef.current) setFavoritesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "FILES") void loadFiles();
  }, [loadFiles, tab]);

  useEffect(() => {
    if (tab === "FAVORITES" && !favoritesAttempted) void loadFavorites();
  }, [favoritesAttempted, loadFavorites, tab]);

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      fileRequestIdRef.current += 1;
      favoriteRequestIdRef.current += 1;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  const visibleFavorites = useMemo(
    () =>
      favorites.filter(
        (favorite) =>
          (favoriteCategory === "ALL" || favorite.type === favoriteCategory) &&
          (!conversationId || favorite.sourceConversationId === conversationId) &&
          favoriteMatchesKeyword(favorite, debouncedKeyword),
      ),
    [conversationId, debouncedKeyword, favoriteCategory, favorites],
  );

  const visibleFavoriteBytes = visibleFavorites.reduce(
    (total, favorite) =>
      total + favorite.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
    0,
  );

  const removeFavorite = async (favorite: MessageFavorite) => {
    if (removingFavoriteId) return;
    setRemovingFavoriteId(favorite.id);
    try {
      await api.deleteFavorite(favorite.id);
      setFavorites((current) => current.filter((item) => item.id !== favorite.id));
      setRemovalCandidateId(null);
      onFavoriteRemoved?.(favorite);
    } catch (removeError) {
      setFavoritesError(errorMessage(removeError, "取消收藏失败"));
    } finally {
      setRemovingFavoriteId(null);
    }
  };

  const activeFilters = tab === "FILES" ? fileFilters : favoriteFilters;
  const activeCategory = tab === "FILES" ? fileCategory : favoriteCategory;
  const currentCount = tab === "FILES" ? fileTotal : visibleFavorites.length;
  const currentBytes = tab === "FILES" ? fileTotalBytes : visibleFavoriteBytes;

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
            {tab === "FILES" ? <FolderOpen size={23} /> : <Bookmark size={23} />}
          </span>
          <div>
            <small>MESSAGE LIBRARY</small>
            <strong id="message-assets-title">消息资产</strong>
            <p>集中查看团队会话中的文件与个人收藏</p>
          </div>
          <div className="message-assets-summary" aria-label="当前筛选统计">
            <span>
              {tab === "FILES" ? <Files size={15} /> : <Bookmark size={15} />}
              <b>{currentCount}</b> 项
            </span>
            <span>
              <HardDrive size={15} />
              {formatBytes(currentBytes)}
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === "FILES"}
            className={tab === "FILES" ? "is-active" : ""}
            onClick={() => setTab("FILES")}
          >
            <FolderOpen size={16} />
            聊天文件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "FAVORITES"}
            className={tab === "FAVORITES" ? "is-active" : ""}
            onClick={() => setTab("FAVORITES")}
          >
            <Bookmark size={16} />
            我的收藏
            {favoritesLoaded && favorites.length > 0 && <b>{favorites.length}</b>}
          </button>
        </div>

        <div className="message-assets-toolbar">
          <label className="message-assets-search">
            <Search size={16} />
            <input
              ref={inputRef}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={tab === "FILES" ? "搜索文件名" : "搜索消息、成员或文件名"}
              maxLength={100}
              aria-label={tab === "FILES" ? "搜索聊天文件" : "搜索我的收藏"}
            />
            {keyword && (
              <button type="button" onClick={() => setKeyword("")} aria-label="清除资产搜索">
                <X size={14} />
              </button>
            )}
          </label>
          <label className="message-assets-conversation-filter">
            <span>会话</span>
            <select
              value={conversationId}
              onChange={(event) => setConversationId(event.target.value)}
              aria-label="按会话筛选消息资产"
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

        <div className="message-assets-filter" role="group" aria-label="按消息类型筛选">
          {activeFilters.map((filter) => {
            const Icon = filter.icon;
            return (
              <button
                type="button"
                key={filter.value}
                className={activeCategory === filter.value ? "is-active" : ""}
                aria-pressed={activeCategory === filter.value}
                onClick={() => {
                  if (tab === "FILES") setFileCategory(filter.value as ChatFileCategory);
                  else setFavoriteCategory(filter.value as FavoriteCategory);
                }}
              >
                <Icon size={15} />
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="message-assets-body">
          {tab === "FILES" ? (
            filesLoading ? (
              <div className="message-assets-state" role="status">
                <LoaderCircle className="spin" size={23} />
                <strong>正在整理聊天文件</strong>
                <span>从你有权访问的会话中汇总</span>
              </div>
            ) : filesError ? (
              <div className="message-assets-state is-error" role="alert">
                <FolderOpen size={24} />
                <strong>文件列表暂时不可用</strong>
                <span>{filesError}</span>
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
            )
          ) : favoritesLoading && !favoritesLoaded ? (
            <div className="message-assets-state" role="status">
              <LoaderCircle className="spin" size={23} />
              <strong>正在打开我的收藏</strong>
              <span>收藏内容只对当前账号可见</span>
            </div>
          ) : favoritesError && !favoritesLoaded ? (
            <div className="message-assets-state is-error" role="alert">
              <Bookmark size={24} />
              <strong>收藏暂时不可用</strong>
              <span>{favoritesError}</span>
              <button type="button" onClick={() => void loadFavorites()}>
                <RefreshCw size={15} />
                重新加载
              </button>
            </div>
          ) : visibleFavorites.length === 0 ? (
            <div className="message-assets-state">
              <Bookmark size={25} />
              <strong>{debouncedKeyword ? "没有匹配的收藏" : "还没有收藏消息"}</strong>
              <span>在消息下方点击收藏图标，文本、图片、语音和附件都会保存在这里</span>
            </div>
          ) : (
            <div className="message-favorites-list">
              {favoritesError && (
                <div className="message-assets-inline-error" role="status">
                  {favoritesError}
                </div>
              )}
              {visibleFavorites.map((favorite) => (
                <article className="message-favorite-card" key={favorite.id}>
                  <header>
                    <Avatar
                      name={favorite.sourceSenderName}
                      color={favorite.sourceSenderAvatarColor}
                      src={favorite.sourceSenderAvatarUrl}
                      size="small"
                    />
                    <span>
                      <strong>{favorite.sourceSenderName}</strong>
                      <small>{favorite.sourceConversationTitle}</small>
                    </span>
                    <time dateTime={favorite.messageCreatedAt}>
                      {formatMessageDay(favorite.messageCreatedAt)}
                    </time>
                  </header>

                  <div className="message-favorite-content">
                    {favorite.textContent && <p>{favorite.textContent}</p>}
                    {favorite.attachments.length > 0 && (
                      <div className="favorite-attachment-list">
                        {favorite.attachments.map((attachment) => (
                          <AttachmentView attachment={attachment} key={attachment.id} />
                        ))}
                      </div>
                    )}
                  </div>

                  <footer>
                    <span className={favorite.sourceAvailable ? "" : "is-detached"}>
                      <Bookmark size={13} />
                      {favorite.sourceAvailable
                        ? "已保存收藏副本"
                        : "原消息已不可用，收藏副本仍保留"}
                    </span>
                    {favorite.sourceAvailable &&
                      favorite.sourceConversationId &&
                      favorite.sourceMessageId && (
                        <button
                          type="button"
                          className="favorite-source-button"
                          onClick={() =>
                            onOpenMessage(favorite.sourceConversationId!, favorite.sourceMessageId!)
                          }
                        >
                          <MapPin size={14} />
                          原消息
                        </button>
                      )}
                    {removalCandidateId === favorite.id ? (
                      <span className="favorite-remove-confirm">
                        <button
                          type="button"
                          className="is-danger"
                          disabled={removingFavoriteId === favorite.id}
                          onClick={() => void removeFavorite(favorite)}
                        >
                          {removingFavoriteId === favorite.id ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            "确认移除"
                          )}
                        </button>
                        <button type="button" onClick={() => setRemovalCandidateId(null)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="favorite-remove-button"
                        onClick={() => setRemovalCandidateId(favorite.id)}
                        aria-label={`取消收藏 ${favorite.sourceSenderName} 的消息`}
                        title="取消收藏"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
