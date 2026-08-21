import {
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import type { AdminUser, ConnectorBinding, ConnectorConfig, ConnectorIdentity } from "../types";
import { deliveryKindLabels, providerInfo } from "./connector-settings-model";

interface ConnectorRelationsProps {
  connector: ConnectorConfig;
  identities: ConnectorIdentity[];
  bindings: ConnectorBinding[];
  users: AdminUser[];
  loading: boolean;
  error: string | null;
  mappingIdentityId: string | null;
  onRefresh: () => void;
  onMapIdentity: (identity: ConnectorIdentity, userId: string) => void;
  onEditBinding: (binding?: ConnectorBinding) => void;
  onDeleteBinding: (binding: ConnectorBinding) => void;
}

function deliveryTargetExpiryLabel(
  connector: ConnectorConfig,
  binding: ConnectorBinding,
): { text: string; tone: "available" | "fallback" | "unavailable" } | null {
  if (connector.provider !== "DINGTALK_STREAM") return null;
  const expiresAt = binding.deliveryTargetExpiresAt
    ? new Date(binding.deliveryTargetExpiresAt)
    : null;
  const sessionAvailable = Boolean(
    binding.hasDeliveryTarget &&
    expiresAt &&
    !Number.isNaN(expiresAt.getTime()) &&
    expiresAt.getTime() > Date.now(),
  );
  if (sessionAvailable && expiresAt) {
    return {
      text: `会话 Webhook 有效至 ${expiresAt.toLocaleString("zh-CN", { hour12: false })}`,
      tone: "available",
    };
  }
  if (binding.hasDingTalkOpenApiRoute) {
    return {
      text: `${binding.hasDeliveryTarget ? "会话 Webhook 已过期或无有效期" : "会话 Webhook 缺失"}，当前由钉钉 OpenAPI 路由投递`,
      tone: "fallback",
    };
  }
  return binding.deliveryKinds.length > 0
    ? {
        text: "等待该会话新消息获取投递路由，当前主动投递不可用",
        tone: "unavailable",
      }
    : null;
}

function DeliveryTargetExpiry({
  connector,
  binding,
}: {
  connector: ConnectorConfig;
  binding: ConnectorBinding;
}) {
  const expiry = deliveryTargetExpiryLabel(connector, binding);
  return expiry ? (
    <small
      className={
        expiry.tone === "unavailable"
          ? "is-warning"
          : expiry.tone === "fallback"
            ? "is-fallback"
            : ""
      }
    >
      {expiry.text}
    </small>
  ) : null;
}

export function ConnectorRelations({
  connector,
  identities,
  bindings,
  users,
  loading,
  error,
  mappingIdentityId,
  onRefresh,
  onMapIdentity,
  onEditBinding,
  onDeleteBinding,
}: ConnectorRelationsProps) {
  const userById = new Map(users.map((user) => [user.id, user]));

  if (loading) {
    return (
      <div className="connector-relations-loading">
        <LoaderCircle className="spin" size={18} /> 正在加载映射
      </div>
    );
  }
  if (error) {
    return (
      <div className="connector-error" role="alert">
        <CircleAlert size={15} />
        <span>{error}</span>
        <button type="button" onClick={onRefresh}>
          重试
        </button>
      </div>
    );
  }

  return (
    <>
      {providerInfo[connector.provider].inbound && (
        <section className="connector-relation-section">
          <div className="connector-section-heading">
            <span>
              <UserRoundCheck size={15} />
              <strong>外部身份映射</strong>
            </span>
            <button type="button" onClick={onRefresh}>
              <RefreshCw size={12} /> 刷新
            </button>
          </div>
          <p>外部用户首次发消息后出现在这里；映射到 NearChat 用户后才能调用其助理。</p>
          {identities.length === 0 ? (
            <div className="connector-relation-empty">暂无已识别的外部用户</div>
          ) : (
            <div className="connector-identity-list">
              {identities.map((identity) => (
                <label key={identity.id}>
                  <span>
                    <strong>{identity.displayName || identity.externalUserId}</strong>
                    <small>{identity.externalUserId}</small>
                  </span>
                  {mappingIdentityId === identity.id && <LoaderCircle className="spin" size={13} />}
                  <select
                    aria-label={`映射 ${identity.displayName || identity.externalUserId}`}
                    value={identity.nearChatUserId ?? ""}
                    disabled={mappingIdentityId === identity.id}
                    onChange={(event) => onMapIdentity(identity, event.target.value)}
                  >
                    <option value="">未映射</option>
                    {users.map((user) => (
                      <option
                        key={user.id}
                        value={user.id}
                        disabled={!user.enabled && identity.nearChatUserId !== user.id}
                      >
                        {user.displayName} (@{user.username}){!user.enabled ? " · 已停用" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="connector-relation-section">
        <div className="connector-section-heading">
          <span>
            <Send size={15} />
            <strong>会话与投递绑定</strong>
          </span>
          <button type="button" onClick={() => onEditBinding()}>
            <Plus size={12} /> 添加绑定
          </button>
        </div>
        <p>一个外部会话绑定一个用户；可选助理负责入站回复，投递类型负责主动消息。</p>
        {bindings.length === 0 ? (
          <div className="connector-relation-empty">暂无会话绑定</div>
        ) : (
          <div className="connector-binding-list">
            {bindings.map((binding) => (
              <article key={binding.id} className={binding.enabled ? "" : "is-disabled"}>
                <div>
                  <strong>{binding.externalConversationId}</strong>
                  <small>
                    {userById.get(binding.ownerId)?.displayName ??
                      `用户 ${binding.ownerId.slice(0, 8)}`}
                    {binding.assistantId ? " · 已绑定助理" : " · 未绑定助理"}
                  </small>
                  <DeliveryTargetExpiry connector={connector} binding={binding} />
                </div>
                <span className="connector-kind-summary">
                  {binding.deliveryKinds.length
                    ? binding.deliveryKinds.map((kind) => deliveryKindLabels[kind]).join("、")
                    : "仅入站"}
                </span>
                <span className="connector-binding-actions">
                  <button
                    type="button"
                    onClick={() => onEditBinding(binding)}
                    aria-label={`编辑绑定 ${binding.externalConversationId}`}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteBinding(binding)}
                    aria-label={`删除绑定 ${binding.externalConversationId}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
