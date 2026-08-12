import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentTheme, initializeTheme, resolveInitialTheme, setThemePreference } from "./theme";

const STORAGE_KEY = "near-chat-theme";

function mockLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

function mockSystemTheme(dark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: dark }),
  });
}

describe("theme preference", () => {
  beforeEach(() => {
    mockLocalStorage();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    mockSystemTheme(false);
  });

  it("首次访问时跟随操作系统主题", () => {
    mockSystemTheme(true);

    expect(resolveInitialTheme()).toBe("dark");
    expect(initializeTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getCurrentTheme()).toBe("dark");
  });

  it("优先恢复用户已经保存的选择", () => {
    mockSystemTheme(true);
    window.localStorage.setItem(STORAGE_KEY, "light");

    expect(resolveInitialTheme()).toBe("light");
  });

  it("切换主题后同步文档状态并持久化", () => {
    setThemePreference("dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });
});
