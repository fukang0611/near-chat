import { AlertTriangle, Check, ClipboardPaste, Image, Search, Send, Type, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "../types";
import { formatBytes } from "../utils/format";
import { Avatar } from "./Avatar";

export type ClipboardRelayContentKind = "text" | "image";

interface ClipboardRelayDialogProps {
  payload: DesktopClipboardRelayPayload;
  users: User[];
  onSend: (peerId: string, kind: ClipboardRelayContentKind) => Promise<boolean>;
  onDismiss: () => void;
}

/** Electron 专属的发送确认层：先看内容、再选联系人，避免全局快捷键误发。 */
export function ClipboardRelayDialog({
  payload,
  users,
  onSend,
  onDismiss,
}: ClipboardRelayDialogProps) {
  const textAvailable = Boolean(payload.text && payload.text.length <= 5_000);
  const imageAvailable = Boolean(payload.imageDataUrl);
  const [kind, setKind] = useState<ClipboardRelayContentKind>(imageAvailable ? "image" : "text");
  const [selectedPeerId, setSelectedPeerId] = useState(users[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) onDismiss();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onDismiss, sending]);

  useEffect(() => {
    if (!selectedPeerId && users[0]) setSelectedPeerId(users[0].id);
  }, [selectedPeerId, users]);

  const filteredUsers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return users.filter(
      (user) =>
        !keyword ||
        user.displayName.toLowerCase().includes(keyword) ||
        user.username.toLowerCase().includes(keyword),
    );
  }, [search, users]);

  const selectedPeer = users.find((user) => user.id === selectedPeerId) ?? null;
  const contentAvailable = kind === "image" ? imageAvailable : textAvailable;

  const submit = async () => {
    if (!selectedPeer || !contentAvailable || sending) return;
    setSending(true);
    try {
      await onSend(selectedPeer.id, kind);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="clipboard-relay-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) onDismiss();
      }}
    >
      <section
        className="clipboard-relay-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clipboard-relay-title"
      >
        <header>
          <span className="clipboard-relay-symbol">
            <ClipboardPaste size={19} />
          </span>
          <span>
            <small>DESKTOP RELAY</small>
            <strong id="clipboard-relay-title">发送剪贴板内容</strong>
          </span>
          <button type="button" onClick={onDismiss} disabled={sending} aria-label="关闭剪贴板接力">
            <X size={17} />
          </button>
        </header>

        <div className="clipboard-relay-body">
          <div className="clipboard-preview-card">
            <div className="clipboard-kind-tabs" role="tablist" aria-label="剪贴板内容类型">
              {imageAvailable && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={kind === "image"}
                  className={kind === "image" ? "is-active" : ""}
                  onClick={() => setKind("image")}
                >
                  <Image size={14} />
                  图片
                </button>
              )}
              {payload.text && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={kind === "text"}
                  className={kind === "text" ? "is-active" : ""}
                  onClick={() => setKind("text")}
                >
                  <Type size={14} />
                  文字
                </button>
              )}
            </div>

            {kind === "image" && payload.imageDataUrl ? (
              <div className="clipboard-image-preview">
                <img src={payload.imageDataUrl} alt="剪贴板图片预览" />
                <small>{formatBytes(payload.imageSizeBytes ?? 0)} · PNG</small>
              </div>
            ) : payload.text ? (
              <div className="clipboard-text-preview">
                <p>{payload.text}</p>
                <small>{payload.text.length} 个字符</small>
              </div>
            ) : (
              <div className="clipboard-empty-preview">
                <ClipboardPaste size={22} />
                <span>没有可预览的内容</span>
              </div>
            )}
          </div>

          {payload.issue && (
            <div className="clipboard-relay-warning" role="status">
              <AlertTriangle size={14} />
              {payload.issue}
            </div>
          )}

          <div className="clipboard-target-heading">
            <span>
              <strong>发送给</strong>
              <small>选择一位联系人后再确认发送</small>
            </span>
            <label>
              <Search size={14} />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索联系人"
                aria-label="搜索接力联系人"
              />
            </label>
          </div>

          <div className="clipboard-target-list" role="listbox" aria-label="接力联系人">
            {filteredUsers.map((peer) => (
              <button
                type="button"
                role="option"
                aria-selected={selectedPeerId === peer.id}
                className={selectedPeerId === peer.id ? "is-selected" : ""}
                key={peer.id}
                onClick={() => setSelectedPeerId(peer.id)}
              >
                <Avatar
                  name={peer.displayName}
                  color={peer.avatarColor}
                  src={peer.avatarUrl}
                  size="small"
                  online={peer.online}
                />
                <span>
                  <strong>{peer.displayName}</strong>
                  <small>@{peer.username}</small>
                </span>
                <i>{selectedPeerId === peer.id && <Check size={13} />}</i>
              </button>
            ))}
            {filteredUsers.length === 0 && (
              <div className="clipboard-target-empty">没有匹配的联系人</div>
            )}
          </div>
        </div>

        <footer>
          <span>{selectedPeer ? `将发送给 ${selectedPeer.displayName}` : "请选择联系人"}</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!selectedPeer || !contentAvailable || sending}
          >
            <Send size={15} />
            {sending ? "正在发送" : "确认发送"}
          </button>
        </footer>
      </section>
    </div>
  );
}
