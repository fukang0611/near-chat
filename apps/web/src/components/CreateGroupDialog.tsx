import { Check, LoaderCircle, Search, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../types";
import { errorMessage } from "../utils/errors";
import { Avatar } from "./Avatar";

interface CreateGroupDialogProps {
  users: User[];
  onClose: () => void;
  onCreate: (name: string, memberIds: string[]) => Promise<void>;
}

/** 创建群聊采用独立对话框，避免把临时选择状态混入聊天页的数据编排。 */
export function CreateGroupDialog({ users, onClose, onCreate }: CreateGroupDialogProps) {
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
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
      await onCreate(name.trim(), selectedIds);
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
            <strong id="group-title">创建群聊</strong>
            <small>选择成员并给群聊起一个清晰的名字</small>
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
            创建群聊
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
