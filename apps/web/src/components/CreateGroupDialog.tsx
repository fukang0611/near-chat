import { Check, Clock3, LoaderCircle, Search, UsersRound, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../types";
import { errorMessage } from "../utils/errors";
import { Avatar } from "./Avatar";

interface CreateGroupDialogProps {
  users: User[];
  onClose: () => void;
  onCreate: (name: string, memberIds: string[], expiresAt?: string) => Promise<void>;
}

/** 创建群聊采用独立对话框，避免把临时选择状态混入聊天页的数据编排。 */
export function CreateGroupDialog({ users, onClose, onCreate }: CreateGroupDialogProps) {
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"regular" | "flash">("regular");
  const [flashDuration, setFlashDuration] = useState(120);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, submitting]);

  const filteredUsers = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return [...users]
      .filter(
        (user) =>
          !normalized ||
          user.displayName.toLowerCase().includes(normalized) ||
          user.username.toLowerCase().includes(normalized),
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.online)) - Number(Boolean(left.online)) ||
          left.displayName.localeCompare(right.displayName, "zh-CN"),
      );
  }, [keyword, users]);

  const toggleMember = (userId: string) => {
    setSelectedIds((current) =>
      current.includes(userId)
        ? current.filter((selectedId) => selectedId !== userId)
        : [...current, userId],
    );
    setError("");
  };

  const submit = async () => {
    if (name.trim().length < 2) {
      setError("群聊名称至少需要 2 个字符");
      return;
    }
    if (selectedIds.length < 2) {
      setError("请至少选择 2 位联系人");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const expiresAt =
        kind === "flash" ? new Date(Date.now() + flashDuration * 60_000).toISOString() : undefined;
      await onCreate(name.trim(), selectedIds, expiresAt);
    } catch (submitError) {
      setError(errorMessage(submitError, "群聊创建失败"));
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        className="group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-title"
      >
        <header>
          <span className="dialog-symbol">
            <UsersRound size={20} />
          </span>
          <div>
            <strong id="group-title">创建团队会话</strong>
            <small>建立常驻群聊，或发起到期自动只读的闪聊</small>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <label className="group-name-field">
          <span>群聊名称</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            maxLength={80}
            placeholder="例如：产品讨论组"
          />
          <small>{name.length}/80</small>
        </label>

        <div className="group-kind-switch" role="group" aria-label="会话类型">
          <button
            type="button"
            className={kind === "regular" ? "is-selected" : ""}
            onClick={() => setKind("regular")}
          >
            <UsersRound size={17} />
            <span>
              <strong>常驻群聊</strong>
              <small>长期保留，持续协作</small>
            </span>
          </button>
          <button
            type="button"
            className={kind === "flash" ? "is-selected is-flash" : "is-flash"}
            onClick={() => setKind("flash")}
          >
            <Zap size={17} />
            <span>
              <strong>闪聊房间</strong>
              <small>到期只读，不删历史</small>
            </span>
          </button>
        </div>

        {kind === "flash" && (
          <div className="flash-duration-picker">
            <span>
              <Clock3 size={14} />
              房间有效时间
            </span>
            <div role="group" aria-label="闪聊有效时间">
              {[
                [30, "30 分钟"],
                [120, "2 小时"],
                [480, "8 小时"],
                [1440, "24 小时"],
              ].map(([minutes, label]) => (
                <button
                  key={minutes}
                  type="button"
                  className={flashDuration === minutes ? "is-selected" : ""}
                  onClick={() => setFlashDuration(minutes as number)}
                >
                  {label}
                </button>
              ))}
            </div>
            <small>到期后禁止发送新消息；历史消息与附件继续保留。</small>
          </div>
        )}

        <label className="group-member-search">
          <Search size={15} />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索联系人"
          />
          <span>已选 {selectedIds.length} 人</span>
        </label>

        <div className="group-member-list">
          {filteredUsers.map((user) => {
            const selected = selectedIds.includes(user.id);
            return (
              <button
                type="button"
                className={selected ? "is-selected" : ""}
                key={user.id}
                onClick={() => toggleMember(user.id)}
                aria-pressed={selected}
              >
                <Avatar
                  name={user.displayName}
                  color={user.avatarColor}
                  src={user.avatarUrl}
                  size="small"
                  online={user.online}
                />
                <span>
                  <strong>{user.displayName}</strong>
                  <small>@{user.username}</small>
                </span>
                <i>{selected && <Check size={14} />}</i>
              </button>
            );
          })}
        </div>

        {error && <p className="dialog-error">{error}</p>}
        <footer>
          <button type="button" className="dialog-cancel" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="dialog-primary"
            onClick={() => void submit()}
            disabled={submitting || name.trim().length < 2 || selectedIds.length < 2}
          >
            {submitting && <LoaderCircle className="spin" size={15} />}
            {kind === "flash" ? "发起闪聊" : "创建群聊"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
