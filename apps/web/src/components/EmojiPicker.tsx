import { Clock3, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMOJI_CATEGORIES,
  loadRecentEmojis,
  rememberRecentEmoji,
  searchEmojis,
  type EmojiItem,
} from "../utils/emoji";

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

/** 离线 Emoji 面板：本地搜索、分类浏览及当前浏览器最近使用。 */
export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [recentEmojis, setRecentEmojis] = useState<EmojiItem[]>(loadRecentEmojis);
  const [activeCategoryId, setActiveCategoryId] = useState(() =>
    recentEmojis.length > 0 ? "recent" : "smileys",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchResults = useMemo(() => searchEmojis(query), [query]);
  const activeCategory = EMOJI_CATEGORIES.find((category) => category.id === activeCategoryId);
  const visibleEmojis = query.trim()
    ? searchResults
    : activeCategoryId === "recent"
      ? recentEmojis
      : (activeCategory?.emojis ?? []);
  const heading = query.trim()
    ? `搜索结果 · ${searchResults.length}`
    : activeCategoryId === "recent"
      ? "最近使用"
      : activeCategory?.label;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  const selectEmoji = (item: EmojiItem) => {
    setRecentEmojis((current) => rememberRecentEmoji(item, current));
    onSelect(item.emoji);
  };

  return (
    <div className="emoji-picker" role="dialog" aria-label="选择表情">
      <header className="emoji-picker-header">
        <label className="emoji-search">
          <Search size={15} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索表情"
            aria-label="搜索表情"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="清除表情搜索">
              <X size={13} />
            </button>
          )}
        </label>
        <button className="emoji-close" type="button" onClick={onClose} aria-label="关闭表情面板">
          <X size={15} />
        </button>
      </header>

      <nav className="emoji-categories" aria-label="表情分类">
        <button
          type="button"
          className={activeCategoryId === "recent" && !query ? "is-active" : ""}
          onClick={() => {
            setQuery("");
            setActiveCategoryId("recent");
          }}
          aria-label="最近使用"
          title="最近使用"
        >
          <Clock3 size={16} />
        </button>
        {EMOJI_CATEGORIES.map((category) => (
          <button
            type="button"
            className={activeCategoryId === category.id && !query ? "is-active" : ""}
            onClick={() => {
              setQuery("");
              setActiveCategoryId(category.id);
            }}
            aria-label={category.label}
            title={category.label}
            key={category.id}
          >
            {category.icon}
          </button>
        ))}
      </nav>

      <section className="emoji-results" aria-label={heading}>
        <div className="emoji-section-heading">
          <strong>{heading}</strong>
          <small>{visibleEmojis.length > 0 ? `${visibleEmojis.length} 个` : ""}</small>
        </div>
        {visibleEmojis.length > 0 ? (
          <div className="emoji-grid">
            {visibleEmojis.map((item) => (
              <button
                type="button"
                onClick={() => selectEmoji(item)}
                aria-label={item.name}
                title={item.name}
                key={`${activeCategoryId}-${item.emoji}`}
              >
                {item.emoji}
              </button>
            ))}
          </div>
        ) : (
          <div className="emoji-empty">
            <span>{query.trim() ? "没有找到匹配的表情" : "还没有最近使用的表情"}</span>
            <small>{query.trim() ? "试试“开心”“加油”或“完成”" : "选择一次后会出现在这里"}</small>
            {!query.trim() && (
              <button type="button" onClick={() => setActiveCategoryId("smileys")}>
                浏览常用表情
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
