/** 当前支持的界面主题。 */
export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "near-chat-theme";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

/**
 * 优先使用用户在近聊中的选择；首次访问时跟随操作系统偏好。
 * localStorage 在隐私模式或受限浏览器中可能不可用，因此始终保留安全回退。
 */
export function resolveInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(storedTheme)) return storedTheme;
  } catch {
    // 存储不可用不应阻止应用启动。
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 在 React 挂载前同步主题，避免页面先亮后暗的闪烁。 */
export function initializeTheme(): ThemeMode {
  const theme = resolveInitialTheme();
  applyThemeToDocument(theme);
  return theme;
}

/** 返回文档当前主题，适合作为 React 状态的初始值。 */
export function getCurrentTheme(): ThemeMode {
  if (typeof document === "undefined") return "light";
  const currentTheme = document.documentElement.dataset.theme;
  if (currentTheme === "light" || currentTheme === "dark") return currentTheme;
  return resolveInitialTheme();
}

/**
 * 更新页面主题并记住用户选择。主题只保存在当前浏览器，不写入用户资料。
 */
export function setThemePreference(theme: ThemeMode): void {
  applyThemeToDocument(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 受限环境下仍允许本次页面正常切换。
  }
}

function applyThemeToDocument(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
