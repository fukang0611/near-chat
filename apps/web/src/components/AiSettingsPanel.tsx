import {
  Bot,
  Check,
  CircleAlert,
  Cpu,
  DatabaseZap,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  ServerCog,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, type SaveAiModelInput } from "../api";
import type { AdminAiModel, AdminAiSettings, AiCapabilities } from "../types";
import { errorMessage } from "../utils/errors";

type NoticeTone = "success" | "error" | "info";

interface AiSettingsPanelProps {
  onNotify: (message: string, tone?: NoticeTone) => void;
  onCapabilitiesChanged: (capabilities: AiCapabilities) => void;
}

interface ModelDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  providerModel: string;
  enabled: boolean;
  clearApiKey: boolean;
}

const emptyModel: ModelDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  providerModel: "",
  enabled: true,
  clearApiKey: false,
};

function capabilityTone(status: AiCapabilities["status"]): string {
  if (status === "READY") return "is-ready";
  if (status === "DISABLED") return "is-disabled";
  return "is-warning";
}

export function AiSettingsPanel({ onNotify, onCapabilitiesChanged }: AiSettingsPanelProps) {
  const [settings, setSettings] = useState<AdminAiSettings | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("1536");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [clearEmbeddingKey, setClearEmbeddingKey] = useState(false);
  const [editingModel, setEditingModel] = useState<AdminAiModel | "new" | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel);
  const [savingModel, setSavingModel] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminAiModel | null>(null);

  const applySettingsToForm = useCallback((next: AdminAiSettings) => {
    setSettings(next);
    setEnabled(next.enabled);
    setDefaultModelId(next.defaultChatModelId);
    setEmbeddingBaseUrl(next.embeddingBaseUrl);
    setEmbeddingModel(next.embeddingModel);
    setEmbeddingDimensions(String(next.embeddingDimensions));
    setEmbeddingApiKey("");
    setClearEmbeddingKey(false);
  }, []);

  const acceptResponse = useCallback(
    (result: {
      settings: AdminAiSettings;
      capabilities: AiCapabilities;
      reindexQueued?: number;
    }) => {
      applySettingsToForm(result.settings);
      setCapabilities(result.capabilities);
      onCapabilitiesChanged(result.capabilities);
    },
    [applySettingsToForm, onCapabilitiesChanged],
  );

  useEffect(() => {
    let active = true;
    void api
      .adminAiSettings()
      .then((result) => {
        if (!active) return;
        acceptResponse(result);
      })
      .catch((error) => onNotify(errorMessage(error, "AI 设置加载失败"), "error"))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [acceptResponse, onNotify]);

  const selectedDefault = useMemo(
    () => settings?.models.find((model) => model.id === defaultModelId) ?? null,
    [defaultModelId, settings?.models],
  );
  const editingExistingModel = editingModel && editingModel !== "new" ? editingModel : null;
  const modelHasConnection = Boolean(
    modelDraft.baseUrl.trim() ||
    modelDraft.apiKey.trim() ||
    (editingExistingModel?.hasApiKey && !modelDraft.clearApiKey),
  );

  const saveGlobalSettings = async () => {
    const dimensions = Number(embeddingDimensions);
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4000) {
      onNotify("Embedding 维度必须是 1 到 4000 的整数", "error");
      return;
    }
    setSaving(true);
    try {
      const result = await api.updateAdminAiSettings({
        enabled,
        defaultChatModelId: defaultModelId,
        embeddingBaseUrl: embeddingBaseUrl.trim() || null,
        embeddingModel: embeddingModel.trim() || null,
        embeddingDimensions: dimensions,
        embeddingApiKey: clearEmbeddingKey
          ? null
          : embeddingApiKey.trim()
            ? embeddingApiKey.trim()
            : undefined,
      });
      acceptResponse(result);
      const suffix = result.reindexQueued ? `，已重新排队 ${result.reindexQueued} 份知识文档` : "";
      onNotify(`AI 全局设置已热应用${suffix}`, "success");
    } catch (error) {
      onNotify(errorMessage(error, "AI 设置保存失败"), "error");
    } finally {
      setSaving(false);
    }
  };

  const openModelEditor = (model?: AdminAiModel) => {
    setDeleteTarget(null);
    setEditingModel(model ?? "new");
    setModelDraft(
      model
        ? {
            name: model.name,
            baseUrl: model.baseUrl,
            apiKey: "",
            providerModel: model.providerModel,
            enabled: model.enabled,
            clearApiKey: false,
          }
        : emptyModel,
    );
  };

  const saveModel = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingModel) return;
    const existing = editingModel === "new" ? null : editingModel;
    const input: SaveAiModelInput = {
      name: modelDraft.name.trim(),
      baseUrl: modelDraft.baseUrl.trim() || null,
      providerModel: modelDraft.providerModel.trim(),
      enabled: modelDraft.enabled,
      apiKey: modelDraft.clearApiKey
        ? null
        : modelDraft.apiKey.trim()
          ? modelDraft.apiKey.trim()
          : undefined,
    };
    setSavingModel(true);
    try {
      const result = existing
        ? await api.updateAdminAiModel(existing.id, input)
        : await api.createAdminAiModel(input);
      acceptResponse(result);
      setEditingModel(null);
      onNotify(existing ? "模型配置已更新并热应用" : "模型已加入目录并热应用", "success");
    } catch (error) {
      onNotify(errorMessage(error, "模型配置保存失败"), "error");
    } finally {
      setSavingModel(false);
    }
  };

  const deleteModel = async () => {
    if (!deleteTarget) return;
    setSavingModel(true);
    try {
      const result = await api.deleteAdminAiModel(deleteTarget.id);
      acceptResponse(result);
      onNotify(`${deleteTarget.name} 已从模型目录移除`, "success");
      setDeleteTarget(null);
    } catch (error) {
      onNotify(errorMessage(error, "模型删除失败"), "error");
    } finally {
      setSavingModel(false);
    }
  };

  if (loading || !settings || !capabilities) {
    return (
      <div className="drawer-loading ai-settings-loading">
        <LoaderCircle className="spin" size={22} /> 正在读取 AI 设置
      </div>
    );
  }

  return (
    <div className="ai-settings-panel">
      <section className="ai-global-card">
        <div className="ai-global-heading">
          <span className="ai-card-icon">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>AI 增强能力</strong>
            <small>全局关闭后仅隐藏 AI 入口，聊天、文件与收藏不受影响</small>
          </div>
          <button
            type="button"
            className={`ai-master-switch ${enabled ? "is-on" : ""}`}
            aria-label={enabled ? "关闭 AI 增强能力" : "启用 AI 增强能力"}
            aria-pressed={enabled}
            onClick={() => setEnabled((current) => !current)}
          >
            <span />
          </button>
        </div>
        <div className={`ai-runtime-status ${capabilityTone(capabilities.status)}`}>
          <span />
          <div>
            <strong>
              {capabilities.status === "READY" ? "运行时已就绪" : capabilities.reason}
            </strong>
            <small>
              {capabilities.status === "READY"
                ? `${capabilities.provider.embeddingModel} · ${settings.models.filter((model) => model.enabled).length} 个对话模型`
                : "保存配置后立即重试，无需重启服务"}
            </small>
          </div>
        </div>
      </section>

      <section className="ai-config-section">
        <div className="ai-section-heading">
          <span>
            <Bot size={17} />
            <strong>对话模型目录</strong>
          </span>
          <button type="button" onClick={() => openModelEditor()}>
            <Plus size={14} /> 添加模型
          </button>
        </div>
        <p className="ai-section-help">
          所有模型均使用 OpenAI 兼容接口。用户可自行选择；个人助理也可按任务绑定不同模型。
        </p>

        {settings.models.length === 0 ? (
          <button className="ai-model-empty" type="button" onClick={() => openModelEditor()}>
            <Cpu size={22} />
            <strong>还没有对话模型</strong>
            <span>添加第一项后，它会自动成为默认模型</span>
          </button>
        ) : (
          <div className="ai-model-list">
            {settings.models.map((model) => (
              <article
                className={`ai-model-row ${model.id === defaultModelId ? "is-default" : ""} ${model.enabled ? "" : "is-disabled"}`}
                key={model.id}
              >
                <span className="ai-model-symbol">
                  <Bot size={17} />
                </span>
                <div className="ai-model-copy">
                  <strong>
                    {model.name}
                    {model.id === defaultModelId && (
                      <span>
                        <Check size={10} /> 默认
                      </span>
                    )}
                  </strong>
                  <small>{model.providerModel}</small>
                  <em>{model.baseUrl || "OpenAI 默认地址"}</em>
                </div>
                <div className="ai-model-actions">
                  {model.enabled && model.id !== defaultModelId && (
                    <button type="button" onClick={() => setDefaultModelId(model.id)}>
                      设为默认
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`编辑 ${model.name}`}
                    onClick={() => openModelEditor(model)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`删除 ${model.name}`}
                    onClick={() => setDeleteTarget(model)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="ai-config-section">
        <div className="ai-section-heading">
          <span>
            <DatabaseZap size={17} />
            <strong>Embedding 与知识库</strong>
          </span>
        </div>
        <p className="ai-section-help">
          全局只使用一个嵌入模型。更换模型、地址、密钥或维度会自动重建知识向量。
        </p>
        <div className="ai-field-grid">
          <label className="is-wide">
            <span>OpenAI 兼容地址</span>
            <div className="ai-input-shell">
              <ServerCog size={15} />
              <input
                value={embeddingBaseUrl}
                onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
                placeholder="例如 http://llm.local:8000/v1"
              />
            </div>
          </label>
          <label>
            <span>模型标识</span>
            <input
              value={embeddingModel}
              onChange={(event) => setEmbeddingModel(event.target.value)}
              placeholder="text-embedding-3-small"
            />
          </label>
          <label>
            <span>向量维度</span>
            <input
              type="number"
              min={1}
              max={4000}
              value={embeddingDimensions}
              onChange={(event) => setEmbeddingDimensions(event.target.value)}
            />
          </label>
          <label className="is-wide">
            <span>
              API Key
              {settings.hasEmbeddingApiKey && !clearEmbeddingKey && <em>已安全保存</em>}
            </span>
            <div className="ai-secret-row">
              <div className="ai-input-shell">
                <KeyRound size={15} />
                <input
                  type="password"
                  value={embeddingApiKey}
                  onChange={(event) => {
                    setEmbeddingApiKey(event.target.value);
                    setClearEmbeddingKey(false);
                  }}
                  placeholder={
                    settings.hasEmbeddingApiKey && !clearEmbeddingKey
                      ? "留空则保留现有密钥"
                      : "本地免鉴权服务可留空"
                  }
                />
              </div>
              {settings.hasEmbeddingApiKey && (
                <button
                  type="button"
                  className={clearEmbeddingKey ? "is-clearing" : ""}
                  onClick={() => {
                    setClearEmbeddingKey((current) => !current);
                    setEmbeddingApiKey("");
                  }}
                >
                  {clearEmbeddingKey ? "取消清除" : "清除密钥"}
                </button>
              )}
            </div>
          </label>
        </div>
      </section>

      <div className="ai-save-bar">
        <div>
          <strong>保存后立即生效</strong>
          <small>当前默认：{selectedDefault?.name ?? "尚未选择"}</small>
        </div>
        <button type="button" onClick={() => void saveGlobalSettings()} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          {saving ? "正在应用" : "保存并应用"}
        </button>
      </div>

      {editingModel && (
        <div
          className="ai-model-editor-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setEditingModel(null);
            }
          }}
        >
          <form
            className="ai-model-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editingModel === "new" ? "添加对话模型" : "编辑对话模型"}
            onSubmit={saveModel}
          >
            <div className="ai-editor-heading">
              <div>
                <span className="ai-card-icon">
                  <Bot size={17} />
                </span>
                <span>
                  <strong>{editingModel === "new" ? "添加对话模型" : "编辑对话模型"}</strong>
                  <small>适用于兼容 OpenAI Chat Completions 的服务</small>
                </span>
              </div>
              <button type="button" aria-label="关闭模型编辑" onClick={() => setEditingModel(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="ai-field-grid">
              <label>
                <span>显示名称</span>
                <input
                  value={modelDraft.name}
                  onChange={(event) =>
                    setModelDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="例如：通用助手"
                  required
                />
              </label>
              <label>
                <span>模型标识</span>
                <input
                  value={modelDraft.providerModel}
                  onChange={(event) =>
                    setModelDraft((current) => ({ ...current, providerModel: event.target.value }))
                  }
                  placeholder="gpt-4.1-mini"
                  required
                />
              </label>
              <label className="is-wide">
                <span>OpenAI 兼容地址</span>
                <input
                  value={modelDraft.baseUrl}
                  onChange={(event) =>
                    setModelDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="留空使用 OpenAI 默认地址；本地服务填写 /v1 地址"
                />
              </label>
              <label className="is-wide">
                <span>
                  API Key
                  {editingModel !== "new" && editingModel.hasApiKey && !modelDraft.clearApiKey && (
                    <em>已安全保存</em>
                  )}
                </span>
                <div className="ai-secret-row">
                  <input
                    type="password"
                    value={modelDraft.apiKey}
                    onChange={(event) =>
                      setModelDraft((current) => ({
                        ...current,
                        apiKey: event.target.value,
                        clearApiKey: false,
                      }))
                    }
                    placeholder={
                      editingModel !== "new" && editingModel.hasApiKey
                        ? "留空则保留现有密钥"
                        : "请输入 API Key"
                    }
                  />
                  {editingModel !== "new" && editingModel.hasApiKey && (
                    <button
                      type="button"
                      className={modelDraft.clearApiKey ? "is-clearing" : ""}
                      onClick={() =>
                        setModelDraft((current) => ({
                          ...current,
                          apiKey: "",
                          clearApiKey: !current.clearApiKey,
                        }))
                      }
                    >
                      {modelDraft.clearApiKey ? "取消清除" : "清除密钥"}
                    </button>
                  )}
                </div>
              </label>
            </div>
            <label className="ai-enabled-check">
              <input
                type="checkbox"
                checked={modelDraft.enabled}
                onChange={(event) =>
                  setModelDraft((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              <span>
                <strong>允许用户与助理选择此模型</strong>
                <small>停用后已有用户偏好会自动回退到全局默认</small>
              </span>
            </label>
            {!modelHasConnection && (
              <div className="ai-inline-warning">
                <CircleAlert size={14} /> 请填写 API Key，或配置一个本地兼容服务地址
              </div>
            )}
            <div className="ai-editor-actions">
              <button type="button" onClick={() => setEditingModel(null)}>
                取消
              </button>
              <button type="submit" disabled={savingModel || !modelHasConnection}>
                {savingModel ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
                保存模型
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="ai-delete-confirm" role="alertdialog" aria-modal="true">
          <span className="ai-card-icon is-danger">
            <Trash2 size={17} />
          </span>
          <div>
            <strong>移除 {deleteTarget.name}？</strong>
            <small>使用该模型的用户会回退到默认项；已启用 AI 时不能删除唯一模型。</small>
          </div>
          <span>
            <button type="button" onClick={() => setDeleteTarget(null)} disabled={savingModel}>
              取消
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void deleteModel()}
              disabled={savingModel}
            >
              {savingModel ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
              移除
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
