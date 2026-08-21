import {
  Activity,
  Bot,
  CircleAlert,
  Clipboard,
  Link2,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type ConnectorConfigInput, type SaveConnectorBindingInput } from "../api";
import type {
  AdminUser,
  AiAssistant,
  ConnectorBinding,
  ConnectorConfig,
  ConnectorDeliveryKind,
  ConnectorIdentity,
  ConnectorOperationEvent,
  Conversation,
  User,
} from "../types";
import { errorMessage } from "../utils/errors";
import { ConnectorBindingEditor } from "./ConnectorBindingEditor";
import { ConnectorConfigEditor } from "./ConnectorConfigEditor";
import { ConnectorOperationsPanel } from "./ConnectorOperationsPanel";
import { ConnectorRelations } from "./ConnectorRelations";
import {
  configFields,
  bindingDraftFromBinding,
  connectorWithRuntime,
  emptyBindingDraft,
  emptyConnectorDraft,
  providerInfo,
  type BindingDraft,
  type ConnectorDraft,
} from "./connector-settings-model";

type NoticeTone = "success" | "error" | "info";

interface ConnectorSettingsPanelProps {
  currentUser: User;
  users: AdminUser[];
  onNotify: (message: string, tone?: NoticeTone) => void;
}

function connectorRuntimeStatus(connector: ConnectorConfig): {
  label: string;
  started: boolean;
} {
  if (connector.runtime.error) return { label: "运行异常", started: false };
  if (!connector.enabled) return { label: "连接器已停用", started: false };
  if (connector.provider === "DINGTALK_STREAM") {
    return connector.runtime.running
      ? { label: "Stream 进程已启动（断线自动重连）", started: true }
      : { label: "Stream 进程尚未启动", started: false };
  }
  return connector.provider === "WECOM_WEBHOOK"
    ? { label: "已启用（外部投递链路未验证）", started: false }
    : { label: "已启用，等待公网回调验收", started: false };
}

export function ConnectorSettingsPanel({
  currentUser,
  users,
  onNotify,
}: ConnectorSettingsPanelProps) {
  const [panelView, setPanelView] = useState<"configuration" | "operations">("configuration");
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configEditor, setConfigEditor] = useState<ConnectorConfig | "new" | null>(null);
  const [connectorDraft, setConnectorDraft] = useState<ConnectorDraft>(emptyConnectorDraft);
  const [savingConfig, setSavingConfig] = useState(false);
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [deleteConnectorTarget, setDeleteConnectorTarget] = useState<ConnectorConfig | null>(null);

  const [identities, setIdentities] = useState<ConnectorIdentity[]>([]);
  const [bindings, setBindings] = useState<ConnectorBinding[]>([]);
  const [loadingRelations, setLoadingRelations] = useState(false);
  const [relationError, setRelationError] = useState<string | null>(null);
  const [mappingIdentityId, setMappingIdentityId] = useState<string | null>(null);
  const [bindingEditor, setBindingEditor] = useState<BindingDraft | null>(null);
  const [bindingPrefill, setBindingPrefill] = useState<{
    connectorId: string;
    draft: BindingDraft;
  } | null>(null);
  const [savingBinding, setSavingBinding] = useState(false);
  const [deleteBindingTarget, setDeleteBindingTarget] = useState<ConnectorBinding | null>(null);
  const [assistants, setAssistants] = useState<AiAssistant[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const relationRequestRef = useRef(0);

  const selected = useMemo(
    () => connectors.find((connector) => connector.id === selectedId) ?? null,
    [connectors, selectedId],
  );
  const selectedRuntimeStatus = selected ? connectorRuntimeStatus(selected) : null;
  const directoryUsers = useMemo<AdminUser[]>(
    () =>
      users.some((user) => user.id === currentUser.id)
        ? users
        : [
            {
              ...currentUser,
              role: currentUser.role ?? "ADMIN",
              enabled: true,
              online: Boolean(currentUser.online),
            },
            ...users,
          ],
    [currentUser, users],
  );
  const enabledUsers = useMemo(
    () => directoryUsers.filter((user) => user.enabled),
    [directoryUsers],
  );
  useEffect(
    () => () => {
      relationRequestRef.current += 1;
    },
    [],
  );

  const loadConnectors = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await api.adminConnectors();
      setConnectors(result.connectors);
      setSelectedId((current) =>
        current && result.connectors.some((connector) => connector.id === current)
          ? current
          : (result.connectors[0]?.id ?? null),
      );
    } catch (error) {
      const message = errorMessage(error, "连接器列表加载失败");
      setLoadError(message);
      onNotify(message, "error");
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadConnectors();
    void Promise.allSettled([api.aiAssistants(), api.conversations()]).then(
      ([assistantResult, conversationResult]) => {
        if (assistantResult.status === "fulfilled") setAssistants(assistantResult.value.assistants);
        if (conversationResult.status === "fulfilled")
          setConversations(conversationResult.value.conversations);
      },
    );
  }, [loadConnectors]);

  const loadRelations = useCallback(async (connectorId: string) => {
    const requestId = ++relationRequestRef.current;
    setLoadingRelations(true);
    setRelationError(null);
    try {
      const [identityResult, bindingResult] = await Promise.all([
        api.connectorIdentities(connectorId),
        api.connectorBindings(connectorId),
      ]);
      if (requestId === relationRequestRef.current) {
        setIdentities(identityResult.identities);
        setBindings(bindingResult.bindings);
      }
    } catch (error) {
      if (requestId === relationRequestRef.current) {
        setRelationError(errorMessage(error, "连接器映射加载失败"));
      }
    } finally {
      if (requestId === relationRequestRef.current) setLoadingRelations(false);
    }
  }, []);

  useEffect(() => {
    setBindingEditor(null);
    setDeleteBindingTarget(null);
    if (selectedId) void loadRelations(selectedId);
    else {
      relationRequestRef.current += 1;
      setIdentities([]);
      setBindings([]);
      setLoadingRelations(false);
    }
  }, [loadRelations, selectedId]);

  useEffect(() => {
    if (!bindingPrefill || bindingPrefill.connectorId !== selectedId) return;
    setBindingEditor(bindingPrefill.draft);
    setBindingPrefill(null);
  }, [bindingPrefill, selectedId]);

  const replaceConnector = (next: ConnectorConfig) => {
    setConnectors((current) =>
      current.map((connector) => (connector.id === next.id ? next : connector)),
    );
  };

  const handleConflictOrNotify = async (error: unknown, fallback: string): Promise<boolean> => {
    if (error instanceof ApiError && error.status === 409) {
      onNotify("配置已被其他管理员更新，已刷新到最新版本", "error");
      await loadConnectors();
      return true;
    }
    onNotify(errorMessage(error, fallback), "error");
    return false;
  };

  const beginCreate = () => {
    setPanelView("configuration");
    setDeleteConnectorTarget(null);
    setConnectorDraft(emptyConnectorDraft);
    setConfigEditor("new");
  };

  const switchPanelView = (next: "configuration" | "operations") => {
    setPanelView(next);
    setConfigEditor(null);
    setBindingEditor(null);
    setDeleteConnectorTarget(null);
    setDeleteBindingTarget(null);
  };

  const beginEdit = (connector: ConnectorConfig) => {
    setDeleteConnectorTarget(null);
    setConnectorDraft({
      ...emptyConnectorDraft,
      provider: connector.provider,
      name: connector.name,
      enabled: connector.enabled,
    });
    setConfigEditor(connector);
  };

  const saveConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!configEditor) return;
    setSavingConfig(true);
    try {
      const config = Object.fromEntries(
        configFields[connectorDraft.provider]
          .map(({ key }) => [key, connectorDraft[key].trim()] as const)
          .filter(([, value]) => value),
      ) as ConnectorConfigInput;
      if (configEditor === "new") {
        const result = await api.createAdminConnector({
          provider: connectorDraft.provider,
          name: connectorDraft.name.trim(),
          enabled: connectorDraft.enabled,
          config,
        });
        const created = connectorWithRuntime(result.connector, result.runtime);
        setConnectors((current) => [...current, created]);
        setSelectedId(created.id);
        onNotify(`${created.name} 已创建`, result.runtime.error ? "error" : "success");
      } else {
        const result = await api.updateAdminConnector(configEditor.id, {
          name: connectorDraft.name.trim(),
          enabled: connectorDraft.enabled,
          revision: configEditor.revision,
          ...(Object.keys(config).length ? { config } : {}),
        });
        const updated = connectorWithRuntime(result.connector, result.runtime);
        replaceConnector(updated);
        onNotify(`${updated.name} 已保存`, result.runtime.error ? "error" : "success");
      }
      setConfigEditor(null);
    } catch (error) {
      if (await handleConflictOrNotify(error, "连接器配置保存失败")) {
        setConfigEditor(null);
      }
    } finally {
      setSavingConfig(false);
    }
  };

  const toggleConnector = async (connector: ConnectorConfig) => {
    setBusyConnectorId(connector.id);
    try {
      const result = await api.updateAdminConnector(connector.id, {
        revision: connector.revision,
        enabled: !connector.enabled,
      });
      const updated = connectorWithRuntime(result.connector, result.runtime);
      replaceConnector(updated);
      onNotify(
        `${connector.name} 已${updated.enabled ? "启用" : "停用"}${result.runtime.error ? `：${result.runtime.error}` : ""}`,
        result.runtime.error ? "error" : "success",
      );
    } catch (error) {
      await handleConflictOrNotify(error, "连接器状态更新失败");
    } finally {
      setBusyConnectorId(null);
    }
  };

  const deleteConnector = async () => {
    if (!deleteConnectorTarget) return;
    setBusyConnectorId(deleteConnectorTarget.id);
    try {
      await api.deleteAdminConnector(deleteConnectorTarget.id);
      setConnectors((current) =>
        current.filter((connector) => connector.id !== deleteConnectorTarget.id),
      );
      setSelectedId((current) => (current === deleteConnectorTarget.id ? null : current));
      onNotify(`${deleteConnectorTarget.name} 已删除`, "success");
      setDeleteConnectorTarget(null);
      await loadConnectors();
    } catch (error) {
      onNotify(errorMessage(error, "连接器删除失败"), "error");
    } finally {
      setBusyConnectorId(null);
    }
  };

  const mapIdentity = async (identity: ConnectorIdentity, userId: string) => {
    setMappingIdentityId(identity.id);
    try {
      const result = await api.mapConnectorIdentity(
        identity.connectorId,
        identity.externalUserId,
        userId || null,
      );
      setIdentities((current) =>
        current.map((item) => (item.id === identity.id ? result.identity : item)),
      );
      onNotify(`${identity.displayName} 的身份映射已保存`, "success");
    } catch (error) {
      onNotify(errorMessage(error, "身份映射保存失败"), "error");
    } finally {
      setMappingIdentityId(null);
    }
  };

  const beginBinding = (binding?: ConnectorBinding) => {
    setDeleteBindingTarget(null);
    setBindingEditor(
      binding ? bindingDraftFromBinding(binding) : emptyBindingDraft(currentUser.id),
    );
  };

  const beginBindingFromEvent = async (event: ConnectorOperationEvent) => {
    if (!event.externalConversationId) {
      onNotify("该事件没有可绑定的外部会话标识", "error");
      return;
    }
    if (!connectors.some((connector) => connector.id === event.connectorId)) {
      onNotify("事件对应的连接器已不存在，已刷新连接器列表", "error");
      void loadConnectors();
      return;
    }
    try {
      const result = await api.connectorBindings(event.connectorId);
      const existing = result.bindings.find(
        (binding) => binding.externalConversationId === event.externalConversationId,
      );
      setConfigEditor(null);
      setDeleteConnectorTarget(null);
      setDeleteBindingTarget(null);
      setBindingPrefill({
        connectorId: event.connectorId,
        draft: existing
          ? bindingDraftFromBinding(existing)
          : {
              ...emptyBindingDraft(currentUser.id),
              externalConversationId: event.externalConversationId,
            },
      });
      setSelectedId(event.connectorId);
      setPanelView("configuration");
    } catch (error) {
      onNotify(errorMessage(error, "会话绑定状态加载失败"), "error");
    }
  };

  const toggleDeliveryKind = (kind: ConnectorDeliveryKind) => {
    setBindingEditor((current) => {
      if (!current) return current;
      const removing = current.deliveryKinds.includes(kind);
      return {
        ...current,
        deliveryKinds: removing
          ? current.deliveryKinds.filter((item) => item !== kind)
          : [...current.deliveryKinds, kind],
        clearDeliveryTarget: removing ? current.clearDeliveryTarget : false,
      };
    });
  };

  const saveBinding = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !bindingEditor) return;
    const deliveryTarget = bindingEditor.deliveryTarget.trim();
    const expiry = bindingEditor.deliveryTargetExpiresAt
      ? new Date(bindingEditor.deliveryTargetExpiresAt)
      : null;
    const expiryIsFuture =
      expiry && !Number.isNaN(expiry.getTime()) && expiry.getTime() > Date.now();
    const shouldUpdateDingTalkExpiry =
      selected.provider === "DINGTALK_STREAM" &&
      !bindingEditor.clearDeliveryTarget &&
      Boolean(
        deliveryTarget ||
        (bindingEditor.deliveryTargetExpiryChanged && bindingEditor.hasExistingDeliveryTarget),
      );
    if (shouldUpdateDingTalkExpiry && !expiryIsFuture) {
      onNotify("钉钉会话 Webhook 必须填写尚未过期的失效时间", "error");
      return;
    }
    setSavingBinding(true);
    try {
      const input: SaveConnectorBindingInput = {
        ...(bindingEditor.id ? { id: bindingEditor.id } : {}),
        ownerId: bindingEditor.ownerId,
        externalConversationId: bindingEditor.externalConversationId.trim(),
        nearChatConversationId: bindingEditor.nearChatConversationId.trim() || null,
        assistantId: bindingEditor.assistantId.trim() || null,
        deliveryKinds: bindingEditor.deliveryKinds,
        enabled: bindingEditor.enabled,
        ...(bindingEditor.metadata ? { metadata: bindingEditor.metadata } : {}),
        ...(bindingEditor.clearDeliveryTarget
          ? { deliveryTarget: null }
          : deliveryTarget
            ? { deliveryTarget }
            : {}),
        ...(shouldUpdateDingTalkExpiry && expiryIsFuture
          ? { deliveryTargetExpiresAt: expiry.toISOString() }
          : {}),
      };
      const result = await api.saveConnectorBinding(selected.id, input);
      setBindings((current) => {
        const exists = current.some((binding) => binding.id === result.binding.id);
        return exists
          ? current.map((binding) => (binding.id === result.binding.id ? result.binding : binding))
          : [result.binding, ...current];
      });
      setBindingEditor(null);
      onNotify("会话绑定已保存", "success");
    } catch (error) {
      onNotify(errorMessage(error, "会话绑定保存失败"), "error");
    } finally {
      setSavingBinding(false);
    }
  };

  const deleteBinding = async () => {
    if (!selected || !deleteBindingTarget) return;
    setSavingBinding(true);
    try {
      await api.deleteConnectorBinding(selected.id, deleteBindingTarget.id);
      setBindings((current) => current.filter((binding) => binding.id !== deleteBindingTarget.id));
      setDeleteBindingTarget(null);
      onNotify("会话绑定已删除", "success");
    } catch (error) {
      onNotify(errorMessage(error, "会话绑定删除失败"), "error");
    } finally {
      setSavingBinding(false);
    }
  };

  const copyCallback = async (callbackUrl: string) => {
    try {
      const parsed = new URL(callbackUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
      await navigator.clipboard.writeText(callbackUrl);
      onNotify("回调地址已复制", "success");
    } catch {
      onNotify("无法自动复制，请手动选择回调地址", "info");
    }
  };

  if (loading) {
    return (
      <div className="connector-loading drawer-loading">
        <LoaderCircle className="spin" size={22} /> 正在加载连接器
      </div>
    );
  }

  return (
    <section className="connector-settings-panel" aria-label="外部连接器管理">
      <div className="connector-toolbar">
        <div>
          <strong>外部平台接入</strong>
          <small>密钥加密保存在服务端，管理页面只显示配置状态</small>
        </div>
        <button type="button" onClick={beginCreate}>
          <Plus size={14} /> 新建连接器
        </button>
      </div>

      <div className="connector-panel-tabs" role="tablist" aria-label="连接器管理视图">
        <button
          type="button"
          role="tab"
          aria-selected={panelView === "configuration"}
          className={panelView === "configuration" ? "is-active" : ""}
          onClick={() => switchPanelView("configuration")}
        >
          <PlugZap size={13} /> 配置与映射
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panelView === "operations"}
          className={panelView === "operations" ? "is-active" : ""}
          onClick={() => switchPanelView("operations")}
        >
          <Activity size={13} /> 故障与恢复
        </button>
      </div>

      {panelView === "operations" ? (
        <ConnectorOperationsPanel
          connectors={connectors}
          onNotify={onNotify}
          onCreateBinding={beginBindingFromEvent}
        />
      ) : loadError ? (
        <div className="connector-error" role="alert">
          <CircleAlert size={16} />
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadConnectors()}>
            重试
          </button>
        </div>
      ) : connectors.length === 0 ? (
        <div className="connector-empty">
          <PlugZap size={25} />
          <strong>还没有外部连接器</strong>
          <span>可接入钉钉机器人或企业微信，连接个人助理、任务与提醒</span>
          <button type="button" onClick={beginCreate}>
            创建第一个连接器
          </button>
        </div>
      ) : (
        <div className="connector-layout">
          <div className="connector-list" aria-label="连接器列表">
            {connectors.map((connector) => {
              const provider = providerInfo[connector.provider];
              const active = connector.id === selectedId;
              const runtimeStatus = connectorRuntimeStatus(connector);
              return (
                <button
                  key={connector.id}
                  type="button"
                  className={`connector-list-item ${active ? "is-active" : ""}`}
                  onClick={() => setSelectedId(connector.id)}
                >
                  <span className="connector-provider-icon">
                    {connector.provider === "DINGTALK_STREAM" ? (
                      <Bot size={17} />
                    ) : (
                      <Webhook size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{connector.name}</strong>
                    <small>{provider.name}</small>
                  </span>
                  <i
                    className={
                      connector.runtime.error
                        ? "is-error"
                        : runtimeStatus.started
                          ? "is-running"
                          : ""
                    }
                    aria-label={runtimeStatus.label}
                  />
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="connector-detail">
              <header className="connector-detail-heading">
                <div>
                  <span className="connector-provider-icon">
                    <PlugZap size={18} />
                  </span>
                  <span>
                    <strong>{selected.name}</strong>
                    <small>{providerInfo[selected.provider].description}</small>
                  </span>
                </div>
                <div className="connector-detail-actions">
                  <button
                    type="button"
                    onClick={() => beginEdit(selected)}
                    aria-label={`编辑 ${selected.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConnectorTarget(selected)}
                    aria-label={`删除 ${selected.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    type="button"
                    className={`connector-switch ${selected.enabled ? "is-on" : ""}`}
                    onClick={() => void toggleConnector(selected)}
                    disabled={busyConnectorId === selected.id}
                    aria-label={
                      selected.enabled ? `停用 ${selected.name}` : `启用 ${selected.name}`
                    }
                    aria-pressed={selected.enabled}
                  >
                    <span />
                  </button>
                </div>
              </header>

              <div
                className={`connector-runtime ${selected.runtime.error ? "is-error" : selectedRuntimeStatus?.started ? "is-running" : ""}`}
              >
                <span />
                <div>
                  <strong>{selectedRuntimeStatus?.label}</strong>
                  <small>{selected.runtime.error ?? `配置版本 ${selected.revision}`}</small>
                  {selected.enabled && (
                    <small className="connector-runtime-impact">
                      停用连接器会取消待处理队列；已 RUNNING 的投递可能已完成。
                    </small>
                  )}
                </div>
              </div>

              {selected.provider === "WECOM_CALLBACK" && (
                <div
                  className={`connector-callback-card ${selected.callbackUrl ? "" : "is-blocked"}`}
                >
                  <span>
                    <Link2 size={15} /> 企业微信回调地址
                  </span>
                  <code>{selected.callbackUrl ?? "需配置公网 HTTPS PUBLIC_BASE_URL"}</code>
                  <button
                    type="button"
                    disabled={!selected.callbackUrl}
                    onClick={() => selected.callbackUrl && void copyCallback(selected.callbackUrl)}
                  >
                    <Clipboard size={13} /> 复制
                  </button>
                </div>
              )}

              <ConnectorRelations
                connector={selected}
                identities={identities}
                bindings={bindings}
                users={directoryUsers}
                loading={loadingRelations}
                error={relationError}
                mappingIdentityId={mappingIdentityId}
                onRefresh={() => void loadRelations(selected.id)}
                onMapIdentity={(identity, userId) => void mapIdentity(identity, userId)}
                onEditBinding={beginBinding}
                onDeleteBinding={setDeleteBindingTarget}
              />
            </div>
          )}
        </div>
      )}

      {configEditor && (
        <ConnectorConfigEditor
          editing={configEditor}
          draft={connectorDraft}
          saving={savingConfig}
          onDraftChange={setConnectorDraft}
          onSubmit={saveConfig}
          onClose={() => setConfigEditor(null)}
        />
      )}

      {bindingEditor && selected && (
        <ConnectorBindingEditor
          connector={selected}
          currentUser={currentUser}
          users={enabledUsers}
          assistants={assistants}
          conversations={conversations}
          draft={bindingEditor}
          saving={savingBinding}
          onDraftChange={setBindingEditor}
          onToggleDeliveryKind={toggleDeliveryKind}
          onSubmit={saveBinding}
          onClose={() => setBindingEditor(null)}
        />
      )}

      {deleteConnectorTarget && (
        <div className="connector-confirm" role="alertdialog" aria-modal="true">
          <CircleAlert size={18} />
          <div>
            <strong>删除 {deleteConnectorTarget.name}？</strong>
            <small>身份和会话绑定会一并删除，待处理队列会取消；已 RUNNING 的投递可能已完成。</small>
          </div>
          <span>
            <button type="button" onClick={() => setDeleteConnectorTarget(null)}>
              取消
            </button>
            <button type="button" className="danger" onClick={() => void deleteConnector()}>
              {busyConnectorId === deleteConnectorTarget.id ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Trash2 size={13} />
              )}
              确认删除
            </button>
          </span>
        </div>
      )}

      {deleteBindingTarget && (
        <div className="connector-confirm" role="alertdialog" aria-modal="true">
          <CircleAlert size={18} />
          <div>
            <strong>删除会话绑定？</strong>
            <small>
              {deleteBindingTarget.externalConversationId}
              将停止入站处理，待处理队列会取消；已 RUNNING 的投递可能已完成。
            </small>
          </div>
          <span>
            <button type="button" onClick={() => setDeleteBindingTarget(null)}>
              取消
            </button>
            <button type="button" className="danger" onClick={() => void deleteBinding()}>
              {savingBinding ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
              确认删除
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
