import { PlugZap, LoaderCircle, Save, X } from "lucide-react";
import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import type { ConnectorConfig, ConnectorProvider } from "../types";
import {
  configFields,
  configuredFlags,
  emptyConnectorDraft,
  providerInfo,
  type ConnectorDraft,
} from "./connector-settings-model";

interface ConnectorConfigEditorProps {
  editing: ConnectorConfig | "new";
  draft: ConnectorDraft;
  saving: boolean;
  onDraftChange: Dispatch<SetStateAction<ConnectorDraft>>;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
}

/** 配置编辑器从不接收解密后的配置，已有值只能通过 hasX 标记呈现。 */
export function ConnectorConfigEditor({
  editing,
  draft,
  saving,
  onDraftChange,
  onSubmit,
  onClose,
}: ConnectorConfigEditorProps) {
  return (
    <div className="connector-editor-layer" role="presentation">
      <form className="connector-editor" onSubmit={onSubmit}>
        <header>
          <div>
            <span className="connector-provider-icon">
              <PlugZap size={17} />
            </span>
            <span>
              <strong>{editing === "new" ? "新建连接器" : "编辑连接器"}</strong>
              <small>已保存值不会回显；编辑时留空即保持原配置</small>
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭连接器编辑">
            <X size={16} />
          </button>
        </header>

        <div className="connector-form-grid">
          <label>
            <span>连接器类型</span>
            <select
              value={draft.provider}
              disabled={editing !== "new"}
              onChange={(event) =>
                onDraftChange({
                  ...emptyConnectorDraft,
                  provider: event.target.value as ConnectorProvider,
                })
              }
            >
              {Object.entries(providerInfo).map(([provider, info]) => (
                <option key={provider} value={provider}>
                  {info.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>连接器名称</span>
            <input
              value={draft.name}
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="例如：研发群机器人"
              maxLength={120}
              required
            />
          </label>
          {configFields[draft.provider].map((field) => {
            const configured = editing !== "new" && Boolean(editing[configuredFlags[field.key]]);
            return (
              <label key={field.key} className="is-wide">
                <span>
                  {field.label}
                  {configured && <em>已安全保存</em>}
                </span>
                <input
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={draft[field.key] ?? ""}
                  onChange={(event) =>
                    onDraftChange((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                  placeholder={configured ? "留空保持已保存值" : field.placeholder}
                  required={editing === "new"}
                />
              </label>
            );
          })}
        </div>
        <label className="connector-enabled-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>
            <strong>保存后立即启用</strong>
            <small>钉钉 Stream 会即时连接；企业微信连接器会开放接收或主动投递。</small>
          </span>
        </label>
        <footer>
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="submit" disabled={saving || !draft.name.trim()}>
            {saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
            保存连接器
          </button>
        </footer>
      </form>
    </div>
  );
}
