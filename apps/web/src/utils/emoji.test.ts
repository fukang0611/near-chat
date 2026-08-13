import { beforeEach, describe, expect, it } from "vitest";
import {
  EMOJI_CATEGORIES,
  MAX_RECENT_EMOJIS,
  RECENT_EMOJI_STORAGE_KEY,
  loadRecentEmojis,
  rememberRecentEmoji,
  searchEmojis,
} from "./emoji";

function mockLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

describe("emoji utilities", () => {
  beforeEach(mockLocalStorage);

  it("支持按中文名称和关键词搜索", () => {
    expect(searchEmojis("开心").some((item) => item.emoji === "😀")).toBe(true);
    expect(searchEmojis("完成").some((item) => item.emoji === "✅")).toBe(true);
    expect(searchEmojis("rocket").some((item) => item.emoji === "🚀")).toBe(true);
  });

  it("最近使用去重、置顶并限制数量", () => {
    const allEmojis = EMOJI_CATEGORIES.flatMap((category) => category.emojis);
    let recent = allEmojis.slice(0, MAX_RECENT_EMOJIS);

    recent = rememberRecentEmoji(allEmojis[MAX_RECENT_EMOJIS], recent);
    recent = rememberRecentEmoji(recent[3], recent);

    expect(recent).toHaveLength(MAX_RECENT_EMOJIS);
    expect(recent[0].emoji).toBe(allEmojis[2].emoji);
    expect(new Set(recent.map((item) => item.emoji)).size).toBe(recent.length);
    expect(loadRecentEmojis().map((item) => item.emoji)).toEqual(
      JSON.parse(window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? "[]"),
    );
  });
});
