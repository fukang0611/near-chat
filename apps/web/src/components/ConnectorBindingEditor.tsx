import { Link2, LoaderCircle, Save, X } from "lucide-react";
import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import type {
  AdminUser,
  AiAssistant,
  ConnectorConfig,
  ConnectorDeliveryKind,
  Conversation,
  User,
} from "../types";
import { deliveryKindLabels, type BindingDraft } from "./connector-settings-model";

interface ConnectorBindingEditorProps {
  connector: ConnectorConfig;
  currentUser: User;
  users: AdminUser[];
  assistants: AiAssistant[];
  conversations: Conversation[];
  draft: BindingDraft;
  saving: boolean;
  onDraftChange: Dispatch<SetStateAction<BindingDraft | null>>;
  onToggleDeliveryKind: (kind: ConnectorDeliveryKind) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}

export function ConnectorBindingEditor({
  connector,
  currentUser,
  users,
  assistants,
  conversations,
  draft,
  saving,
  onDraftChange,
  onToggleDeliveryKind,
  onSubmit,
  onClose,
}: ConnectorBindingEditorProps) {
  const expiryTimestamp = draft.deliveryTargetExpiresAt
    ? new Date(draft.deliveryTargetExpiresAt).getTime()
    : Number.NaN;
  const hasSessionTarget = Boolean(draft.deliveryTarget.trim() || draft.hasExistingDeliveryTarget);
  const sessionAvailable =
    hasSessionTarget && Number.isFinite(expiryTimestamp) && expiryTimestamp > Date.now();
  const targetExpired = draft.hasExistingDeliveryTarget && !sessionAvailable;
  const minimumExpiry = new Date(Date.now() + 60_000);
  minimumExpiry.setMinutes(minimumExpiry.getMinutes() - minimumExpiry.getTimezoneOffset());

  return (
    <div className="connector-editor-layer" role="presentation">
      <form className="connector-editor connector-binding-editor" onSubmit={onSubmit}>
        <header>
          <div>
            <span className="connector-provider-icon">
              <Link2 size={17} />
            </span>
            <span>
              <strong>{draft.id ? "编辑会话绑定" : "添加会话绑定"}</strong>
              <small>外部会话、NearChat 用户与个人助理的授权边界</small>
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭会话绑定编辑">
            <X size={16} />
          </button>
        </header>

        <div className="connector-form-grid">
          <label>
            <span>绑定用户</span>
            <select
              aria-label="绑定用户"
              value={draft.ownerId}
              onChange={(event) =>
                onDraftChange((current) =>
                  current
                    ? {
                        ...current,
                        ownerId: event.target.value,
                        assistantId: "",
                        nearChatConversationId: "",
                      }
                    : current,
                )
              }
              required
              disabled={Boolean(draft.id)}
              aria-disabled={Boolean(draft.id)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} (@{user.username})
                </option>
              ))}
            </select>
            {draft.id && <small>所属用户不可直接更换；如需转移，请删除后重新绑定。</small>}
          </label>
          <label>
            <span>外部会话 ID</span>
            <input
              aria-label="外部会话 ID"
              value={draft.externalConversationId}
              readOnly={Boolean(draft.id)}
              aria-readonly={Boolean(draft.id)}
              onChange={(event) =>
                onDraftChange((current) =>
                  current ? { ...current, externalConversationId: event.target.value } : current,
                )
              }
              placeholder={
                connector.provider === "WECOM_WEBHOOK" ? "例如：default-group" : "平台会话 ID"
              }
              required
            />
            {draft.id && <small>已有绑定的外部会话不可更改；如需变更，请删除后重新绑定。</small>}
          </label>
          <label className="is-wide">
            <span>个人助理 ID（可选）</span>
            <input
              list="connector-assistant-options"
              value={draft.assistantId}
              onChange={(event) =>
                onDraftChange((current) =>
                  current ? { ...current, assistantId: event.target.value } : current,
                )
              }
              placeholder="入站自动回复需要填写该用户的助理 UUID"
            />
            {draft.ownerId !== currentUser.id && (
              <small>当前管理接口不能枚举其他用户的助理，请粘贴该用户自己的助理 ID。</small>
            )}
          </label>
          <label className="is-wide">
            <span>NearChat 会话 ID（可选）</span>
            <input
              list="connector-conversation-options"
              value={draft.nearChatConversationId}
              onChange={(event) =>
                onDraftChange((current) =>
                  current ? { ...current, nearChatConversationId: event.target.value } : current,
                )
              }
              placeholder="只允许该用户已加入的会话 UUID"
            />
          </label>
        </div>
        <datalist id="connector-assistant-options">
          {draft.ownerId === currentUser.id &&
            assistants.map((assistant) => (
              <option key={assistant.id} value={assistant.id}>
                {assistant.name}
              </option>
            ))}
        </datalist>
        <datalist id="connector-conversation-options">
          {draft.ownerId === currentUser.id &&
            conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
        </datalist>

        <fieldset className="connector-kind-fieldset">
          <legend>主动投递类型</legend>
          <div>
            {(Object.keys(deliveryKindLabels) as ConnectorDeliveryKind[]).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={draft.deliveryKinds.includes(kind)}
                  onChange={() => onToggleDeliveryKind(kind)}
                />
                {deliveryKindLabels[kind]}
              </label>
            ))}
          </div>
          <small className="connector-queue-impact">
            取消投递类型会取消相关待处理队列；已 RUNNING 的投递可能已完成。
          </small>
        </fieldset>

        {connector.provider !== "WECOM_WEBHOOK" && (
          <div className="connector-target-field">
            <span>
              {connector.provider === "DINGTALK_STREAM" ? "钉钉会话 Webhook" : "企业微信成员账号"}
              {draft.id && <em>留空保持已保存目标</em>}
            </span>
            <input
              aria-label={
                connector.provider === "DINGTALK_STREAM" ? "钉钉会话 Webhook" : "企业微信成员账号"
              }
              type="password"
              autoComplete="off"
              value={draft.deliveryTarget}
              disabled={draft.clearDeliveryTarget}
              onChange={(event) =>
                onDraftChange((current) =>
                  current ? { ...current, deliveryTarget: event.target.value } : current,
                )
              }
              placeholder={
                connector.provider === "DINGTALK_STREAM"
                  ? "主动投递需要会话 Webhook"
                  : "主动投递需要企业微信 UserID"
              }
            />
            {connector.provider === "DINGTALK_STREAM" && (
              <label className="connector-expiry-field">
                <span>
                  Webhook 失效时间
                  {targetExpired && (
                    <em>
                      {draft.hasDingTalkOpenApiRoute
                        ? "会话凭据不可用，将回退 OpenAPI"
                        : "会话凭据不可用，请更新或等待新消息"}
                    </em>
                  )}
                </span>
                <input
                  type="datetime-local"
                  aria-label="Webhook 失效时间"
                  min={
                    draft.deliveryTargetExpiryChanged || draft.deliveryTarget.trim()
                      ? minimumExpiry.toISOString().slice(0, 16)
                      : undefined
                  }
                  value={draft.deliveryTargetExpiresAt}
                  disabled={draft.clearDeliveryTarget}
                  required={Boolean(draft.deliveryTarget.trim())}
                  onChange={(event) =>
                    onDraftChange((current) =>
                      current
                        ? {
                            ...current,
                            deliveryTargetExpiresAt: event.target.value,
                            deliveryTargetExpiryChanged: true,
                          }
                        : current,
                    )
                  }
                />
                <small>钉钉会话 Webhook 是短期投递凭据；请填写平台给出的未来失效时间。</small>
                {!sessionAvailable && draft.hasDingTalkOpenApiRoute && (
                  <small className="is-fallback">当前可通过钉钉 OpenAPI 路由主动投递。</small>
                )}
                {!sessionAvailable &&
                  !draft.hasDingTalkOpenApiRoute &&
                  draft.deliveryKinds.length > 0 &&
                  !draft.deliveryTarget.trim() && (
                    <small className="is-warning">
                      等待该会话新消息获取投递路由，当前主动投递不可用。
                    </small>
                  )}
              </label>
            )}
            {draft.id && (
              <label className="connector-clear-target">
                <input
                  type="checkbox"
                  checked={draft.clearDeliveryTarget}
                  disabled={draft.deliveryKinds.length > 0}
                  onChange={(event) =>
                    onDraftChange((current) =>
                      current ? { ...current, clearDeliveryTarget: event.target.checked } : current,
                    )
                  }
                />
                移除已保存的投递目标（需先取消所有主动投递类型）
              </label>
            )}
          </div>
        )}

        <label className="connector-enabled-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              onDraftChange((current) =>
                current ? { ...current, enabled: event.target.checked } : current,
              )
            }
          />
          <span>
            <strong>启用此绑定</strong>
            <small>停用后不会处理入站消息，并会取消待处理投递；已 RUNNING 的投递可能已完成。</small>
          </span>
        </label>
        <footer>
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !draft.ownerId || !draft.externalConversationId.trim()}
          >
            {saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
            保存绑定
          </button>
        </footer>
      </form>
    </div>
  );
}
