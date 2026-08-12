import { Moon, Sun } from "lucide-react";
import type { ThemeMode } from "../utils/theme";

interface ThemeToggleProps {
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
  compact?: boolean;
  className?: string;
}

/**
 * 登录页使用双选分段控件，空间较窄的聊天栏使用单按钮快捷切换。
 * 两种形态都明确暴露当前状态，便于键盘和读屏用户理解。
 */
export function ThemeToggle({
  theme,
  onChange,
  compact = false,
  className = "",
}: ThemeToggleProps) {
  if (compact) {
    const nextTheme: ThemeMode = theme === "light" ? "dark" : "light";
    const label = nextTheme === "dark" ? "切换到黑暗主题" : "切换到明亮主题";

    return (
      <button
        type="button"
        className={`theme-quick-toggle ${className}`.trim()}
        onClick={() => onChange(nextTheme)}
        aria-label={label}
        title={label}
      >
        {nextTheme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
    );
  }

  return (
    <div className={`theme-toggle ${className}`.trim()} role="group" aria-label="界面主题">
      <button
        type="button"
        className={theme === "light" ? "is-active" : ""}
        onClick={() => onChange("light")}
        aria-pressed={theme === "light"}
      >
        <Sun size={14} />
        明亮
      </button>
      <button
        type="button"
        className={theme === "dark" ? "is-active" : ""}
        onClick={() => onChange("dark")}
        aria-pressed={theme === "dark"}
      >
        <Moon size={14} />
        黑暗
      </button>
    </div>
  );
}
