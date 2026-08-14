import {
  AlignLeft,
  AlertCircle,
  Check,
  Copy,
  FileCheck2,
  FileText,
  Languages,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  ScanSearch,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  AiModelChoice,
  Message,
  MessageAiAction,
  MessageAiActionResult,
  MessageAiTargetLanguage,
} from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";

interface MessageAiActionDialogProps {
  message: Message;
  onClose: () => void;
  onApplyToDraft: (content: string) => boolean;
}

const ACTIONS: Array<{
  id: MessageAiAction;
  label: string;
  description: string;
  icon: typeof Sparkles;
}> = [
  { id: "SUMMARIZE", label: "总结要点", description: "提炼结论和关键信息", icon: AlignLeft },
  {
    id: "EXTRACT_TASKS",
    label: "提取待办",
    description: "整理动作、负责人和时间",
    icon: ListChecks,
  },
  { id: "REWRITE", label: "润色改写", description: "让表达更清楚、专业", icon: WandSparkles },
  { id: "TRANSLATE", label: "翻译内容", description: "保留原意和结构", icon: Languages },
  { id: "ANALYZE", label: "深度分析", description: "识别事实、风险与下一步", icon: ScanSearch },
];

function actionLabel(action: MessageAiAction, target: MessageAiTargetLanguage): string {
  if (action !== "TRANSLATE") {
    return ACTIONS.find((candidate) => candidate.id === action)?.label ?? "AI 处理";
  }
  return target === "CHINESE" ? "翻译为中文" : "翻译为英文";
}

/**
 * 消息 AI 面板只生成临时结果。用户需要再次点击“追加到输入框”后，结果才进入当前草稿；
 * 原消息、附件和会话历史始终保持不变。
 */
export function MessageAiActionDialog({
  message,
  onClose,
  onApplyToDraft,
}: MessageAiActionDialogProps) {
  const [action, setAction] = useState<MessageAiAction>(
    message.attachments.length > 0 ? "ANALYZE" : "SUMMARIZE",
  );
  const [targetLanguage, setTargetLanguage] = useState<MessageAiTargetLanguage>("ENGLISH");
  const [models, setModels] = useState<AiModelChoice[]>([]);
  const [modelId, setModelId] = useState("");
  const [loadingModels, setLoadingModels] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MessageAiActionResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sourcePreview = useMemo(() => {
    const text = message.textContent?.trim();
    if (!text) return "这是一条附件消息，AI 会读取其中受支持的文档文字。";
    return text.length > 320 ? `${text.slice(0, 320)}…` : text;
  }, [message.textContent]);

  useEffect(() => {
    let active = true;
    api
      .aiModels()
      .then((response) => {
        if (!active) return;
        setModels(response.models);
        setModelId(
          response.selectedModelId ?? response.defaultModelId ?? response.models[0]?.id ?? "",
        );
      })
      .catch((error) => {
        if (active) setNotice(errorMessage(error, "模型列表读取失败"));
      })
      .finally(() => {
        if (active) setLoadingModels(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, running]);

  const selectAction = (nextAction: MessageAiAction) => {
    setAction(nextAction);
    setResult(null);
    setNotice(null);
    setCopied(false);
  };

  const runAction = async () => {
    if (!modelId || running) return;
    setRunning(true);
    setNotice(null);
    setCopied(false);
    try {
      const response = await api.runMessageAiAction(message.id, {
        action,
        targetLanguage: action === "TRANSLATE" ? targetLanguage : undefined,
        modelId,
      });
      setResult(response);
    } catch (error) {
      setNotice(errorMessage(error, "AI 处理失败，请稍后重试"));
    } finally {
      setRunning(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setNotice("复制失败，请手动选择结果文本");
    }
  };

  return (
    <div
      className="message-ai-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <section
        className="message-ai-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 快捷处理"
      >
        <header className="message-ai-header">
          <div>
            <span className="message-ai-brand">
              <Sparkles size={20} />
            </span>
            <span>
              <strong>AI 快捷处理</strong>
              <small>结果由你确认后再写入对话</small>
            </span>
          </div>
          <button type="button" onClick={onClose} disabled={running} aria-label="关闭 AI 快捷处理">
            <X size={18} />
          </button>
        </header>

        <div className="message-ai-workspace">
          <aside className="message-ai-actions-panel">
            <div className="message-ai-section-label">
              <Sparkles size={13} />
              选择处理方式
            </div>
            <div className="message-ai-action-list">
              {ACTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    type="button"
                    className={action === option.id ? "is-active" : ""}
                    key={option.id}
                    onClick={() => selectAction(option.id)}
                    aria-label={option.label}
                    aria-pressed={action === option.id}
                  >
                    <span>
                      <Icon size={16} />
                    </span>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {action === option.id && <Check size={14} />}
                  </button>
                );
              })}
            </div>

            {action === "TRANSLATE" && (
              <div className="message-ai-language" role="group" aria-label="翻译目标语言">
                <button
                  type="button"
                  className={targetLanguage === "ENGLISH" ? "is-active" : ""}
                  onClick={() => {
                    setTargetLanguage("ENGLISH");
                    setResult(null);
                  }}
                >
                  英文
                </button>
                <button
                  type="button"
                  className={targetLanguage === "CHINESE" ? "is-active" : ""}
                  onClick={() => {
                    setTargetLanguage("CHINESE");
                    setResult(null);
                  }}
                >
                  中文
                </button>
              </div>
            )}

            <label className="message-ai-model-field">
              <span>使用模型</span>
              <select
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setResult(null);
                }}
                disabled={loadingModels || running || models.length === 0}
              >
                {models.length === 0 && <option value="">暂无可用模型</option>}
                {models.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.name}
                    {model.isDefault ? " · 默认" : ""}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="message-ai-run"
              onClick={() => void runAction()}
              disabled={running || loadingModels || !modelId}
            >
              {running ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}
              {running ? "正在处理…" : `开始${actionLabel(action, targetLanguage)}`}
            </button>
          </aside>

          <main className="message-ai-result-panel">
            <section className="message-ai-source-card">
              <header>
                <span>
                  <MessageSquareText size={15} />
                  原消息
                </span>
                <small>{message.senderName}</small>
              </header>
              <p>{sourcePreview}</p>
              {message.attachments.length > 0 && (
                <div className="message-ai-source-files">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id} title={attachment.originalName}>
                      <FileText size={13} />
                      <b>{attachment.originalName}</b>
                      <small>{formatBytes(attachment.sizeBytes)}</small>
                    </span>
                  ))}
                </div>
              )}
            </section>

            {notice && (
              <div className="message-ai-notice" role="alert">
                <AlertCircle size={15} />
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
                  <X size={14} />
                </button>
              </div>
            )}

            <section className={`message-ai-output ${running ? "is-running" : ""}`}>
              {running ? (
                <div className="message-ai-thinking">
                  <span className="message-ai-thinking-orbit">
                    <Sparkles size={21} />
                    <i />
                    <i />
                    <i />
                  </span>
                  <strong>正在理解这条消息</strong>
                  <small>文档仅提取文字，原文件不会离开你的 MinIO</small>
                </div>
              ) : result ? (
                <>
                  <header>
                    <span>
                      <FileCheck2 size={15} />
                      {actionLabel(result.action, result.targetLanguage ?? targetLanguage)}结果
                    </span>
                    <small>{result.model.name}</small>
                  </header>
                  <div className="message-ai-output-text" tabIndex={0}>
                    {result.result}
                  </div>
                  {(result.source.attachments.length > 0 || result.source.truncated) && (
                    <div className="message-ai-output-meta">
                      {result.source.attachments.map((attachment) => (
                        <span
                          className={attachment.processed ? "is-processed" : ""}
                          key={attachment.id}
                        >
                          {attachment.processed ? <Check size={11} /> : <FileText size={11} />}
                          {attachment.originalName}
                        </span>
                      ))}
                      {result.source.truncated && <small>内容较长，已在安全长度内处理</small>}
                    </div>
                  )}
                  <footer>
                    <button type="button" onClick={() => void copyResult()}>
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      {copied ? "已复制" : "复制结果"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (onApplyToDraft(result.result)) onClose();
                      }}
                    >
                      <MessageSquareText size={15} />
                      追加到输入框
                    </button>
                  </footer>
                </>
              ) : (
                <div className="message-ai-empty">
                  <span>
                    <Sparkles size={22} />
                  </span>
                  <strong>选择一种处理方式</strong>
                  <p>AI 只会读取这条消息的正文和可解析文档，不会修改原内容或自动发送结果。</p>
                </div>
              )}
            </section>
          </main>
        </div>
      </section>
    </div>
  );
}
