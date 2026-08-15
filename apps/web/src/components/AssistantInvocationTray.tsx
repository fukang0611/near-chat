import { AlertCircle, Check, LoaderCircle, PencilLine, Sparkles, X } from "lucide-react";
import { type CSSProperties, useState } from "react";
import type { AssistantInvocation } from "../types";

interface AssistantInvocationTrayProps {
  invocations: AssistantInvocation[];
  onConfirm: (invocation: AssistantInvocation) => Promise<void>;
  onUseDraft: (invocation: AssistantInvocation) => Promise<void>;
  onDismiss: (invocation: AssistantInvocation) => Promise<void>;
}

function statusCopy(invocation: AssistantInvocation) {
  switch (invocation.status) {
    case "QUEUED":
      return "等待开始";
    case "RUNNING":
      return "正在阅读当前会话";
    case "FAILED":
      return invocation.errorMessage || "本次生成失败";
    default:
      return "仅你可见，确认后才会发送";
  }
}

/** 私有预览永远位于消息区与输入框之间，不混入其他成员可见的消息时间线。 */
export function AssistantInvocationTray({
  invocations,
  onConfirm,
  onUseDraft,
  onDismiss,
}: AssistantInvocationTrayProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (invocations.length === 0) return null;

  const run = async (invocation: AssistantInvocation, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(invocation.id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="assistant-invocation-tray" aria-label="助理私有预览">
      {invocations.map((invocation) => {
        const generating = invocation.status === "QUEUED" || invocation.status === "RUNNING";
        const failed = invocation.status === "FAILED";
        const waiting = invocation.status === "WAITING_CONFIRMATION";
        const busy = busyId === invocation.id;
        return (
          <article
            className={`assistant-invocation-card ${failed ? "is-failed" : ""}`}
            key={invocation.id}
          >
            <span
              className="assistant-avatar assistant-invocation-avatar"
              style={{ "--assistant-color": invocation.assistantAvatarColor } as CSSProperties}
              aria-hidden="true"
            >
              <Sparkles size={15} />
            </span>
            <div className="assistant-invocation-copy">
              <header>
                <strong>{invocation.assistantName}</strong>
                <span className="assistant-private-badge">
                  <Sparkles size={11} /> 私有预览
                </span>
              </header>
              {waiting && invocation.resultText ? (
                <p>{invocation.resultText}</p>
              ) : (
                <span className="assistant-invocation-status">
                  {generating ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <AlertCircle size={13} />
                  )}
                  {statusCopy(invocation)}
                </span>
              )}
              {waiting && (
                <footer>
                  <button
                    type="button"
                    className="is-primary"
                    disabled={Boolean(busyId)}
                    onClick={() => void run(invocation, () => onConfirm(invocation))}
                  >
                    {busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
                    发送到会话
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => void run(invocation, () => onUseDraft(invocation))}
                  >
                    <PencilLine size={13} />
                    填入输入框
                  </button>
                </footer>
              )}
            </div>
            {!generating && (
              <button
                className="assistant-invocation-dismiss"
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => void run(invocation, () => onDismiss(invocation))}
                aria-label={`忽略 ${invocation.assistantName} 的预览`}
                title="忽略本次预览"
              >
                <X size={14} />
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
