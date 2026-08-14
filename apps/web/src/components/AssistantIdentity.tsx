import { BrainCircuit, Route, Sparkles, WandSparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { AiAssistant, AiAssistantCategory } from "../types";

export const ASSISTANT_CATEGORY_META: Record<
  AiAssistantCategory,
  { label: string; detail: string }
> = {
  GENERAL: { label: "通用", detail: "灵活处理日常问题" },
  WRITING: { label: "写作", detail: "起草、改写与润色" },
  ANALYSIS: { label: "分析", detail: "归纳信息与辅助判断" },
  PLANNING: { label: "规划", detail: "拆解目标与安排步骤" },
};

export function assistantCategoryIcon(category: AiAssistantCategory, size = 17): ReactNode {
  if (category === "WRITING") return <WandSparkles size={size} />;
  if (category === "ANALYSIS") return <BrainCircuit size={size} />;
  if (category === "PLANNING") return <Route size={size} />;
  return <Sparkles size={size} />;
}

export function formatAssistantTime(value: string | null): string {
  if (!value) return "尚未对话";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

/** 主导航和助理工作区共用同一身份图形，避免同一助理在不同层级出现两套头像。 */
export function AssistantAvatar({
  assistant,
  size = "normal",
}: {
  assistant: AiAssistant;
  size?: "normal" | "large";
}) {
  return (
    <span
      className={`assistant-avatar ${size === "large" ? "is-large" : ""}`}
      style={{ "--assistant-color": assistant.avatarColor } as CSSProperties}
      aria-hidden="true"
    >
      {assistantCategoryIcon(assistant.category, size === "large" ? 24 : 16)}
    </span>
  );
}
