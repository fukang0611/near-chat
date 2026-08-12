import {
  Check,
  Crown,
  DoorOpen,
  LoaderCircle,
  Search,
  Trash2,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Conversation, User } from "../types";
import { errorMessage } from "../utils/errors";
import { Avatar } from "./Avatar";

interface GroupManagementDialogProps {
  conversation: Conversation;
  currentUser: User;
  users: User[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onExited: () => void;
}

type Confirmation =
  | { type: "REMOVE"; user: User }
  | { type: "TRANSFER"; user: User }
  | { type: "LEAVE" }
  | { type: "DISBAND" }
  | null;

const groupColors = ["#5B6EE1", "#6C5CE7", "#2F9E83", "#D97757", "#B65B7A", "#4477B8"];

/** 群资料、成员与高风险操作在同一上下文中完成，权限由服务端再次校验。 */
export function GroupManagementDialog({
  conversation,
  currentUser,
  users,
  onClose,
  onChanged,
  onExited,
}: GroupManagementDialogProps) {
  const [name, setName] = useState(conversation.title);
  const [avatarColor, setAvatarColor] = useState(conversation.avatarColor);
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [error, setError] = useState("");
  const isOwner = conversation.ownerId === currentUser.id;

  useEffect(() => {
    setName(conversation.title);
    setAvatarColor(conversation.avatarColor);
  }, [conversation.avatarColor, conversation.title]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (confirmation) setConfirmation(null);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, confirmation, onClose]);

  const availableUsers = useMemo(() => {
    const memberIds = new Set(conversation.members.map((member) => member.id));
    const normalized = keyword.trim().toLowerCase();
    return users.filter(
      (user) =>
        !memberIds.has(user.id) &&
        (!normalized ||
          user.displayName.toLowerCase().includes(normalized) ||
          user.username.toLowerCase().includes(normalized)),
    );
  }, [conversation.members, keyword, users]);

  const run = async (key: string, action: () => Promise<void>, fallback: string) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = () =>
    run(
      "profile",
      async () => {
        await api.updateGroup(conversation.id, { name: name.trim(), avatarColor });
        await onChanged();
      },
      "群资料保存失败",
    );

  const addMembers = () =>
    run(
      "add",
      async () => {
        await api.addGroupMembers(conversation.id, selectedIds);
        setSelectedIds([]);
        setKeyword("");
        await onChanged();
      },
      "成员添加失败",
    );

  const confirmAction = async () => {
    const pending = confirmation;
    if (!pending) return;
    const key = pending.type.toLowerCase();
    await run(
      key,
      async () => {
        switch (pending.type) {
          case "REMOVE":
            await api.removeGroupMember(conversation.id, pending.user.id);
            setConfirmation(null);
            await onChanged();
            break;
          case "TRANSFER":
            await api.transferGroupOwner(conversation.id, pending.user.id);
            setConfirmation(null);
            await onChanged();
            break;
          case "LEAVE":
            await api.leaveGroup(conversation.id);
            onExited();
            break;
          case "DISBAND":
            await api.disbandGroup(conversation.id);
            onExited();
            break;
        }
      },
      "群聊操作失败",
    );
  };

  const confirmationCopy = (() => {
    if (!confirmation) return null;
    switch (confirmation.type) {
      case "REMOVE":
        return {
          title: `移出 ${confirmation.user.displayName}？`,
          detail: "对方将无法继续查看此群聊和群内文件。",
          action: "确认移出",
        };
      case "TRANSFER":
        return {
          title: `转让给 ${confirmation.user.displayName}？`,
          detail: "转让后你将成为普通成员，新群主可以管理成员和解散群聊。",
          action: "确认转让",
        };
      case "LEAVE":
        return {
          title: "退出当前群聊？",
          detail: isOwner
            ? conversation.memberCount > 1
              ? "退出后，群主会自动转让给最早加入的成员。"
              : "你是最后一位成员，退出后群聊将自动解散。"
            : "退出后将无法查看群消息和文件。",
          action: "确认退出",
        };
      case "DISBAND":
        return {
          title: "解散当前群聊？",
          detail: "群聊和全部历史消息将永久删除，此操作无法撤销。",
          action: "确认解散",
        };
    }
  })();

  return createPortal(
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="group-manage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-group-title"
      >
        <header>
          <span className="dialog-symbol">
            <UsersRound size={20} />
          </span>
          <div>
            <strong id="manage-group-title">群聊设置</strong>
            <small>
              {conversation.memberCount} 位成员 · {isOwner ? "你是群主" : "普通成员"}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭群聊设置">
            <X size={18} />
          </button>
        </header>

        <div className="group-manage-scroll">
          <section className="group-profile-card">
            <div className="group-profile-preview">
              <Avatar name={name} color={avatarColor} />
              <span>
                <strong>{name}</strong>
                <small>{isOwner ? "群资料对所有成员可见" : "只有群主可以修改群资料"}</small>
              </span>
            </div>
            {isOwner && (
              <>
                <label className="settings-field">
                  <span>群聊名称</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                  />
                </label>
                <fieldset className="color-picker compact">
                  <legend>群头像颜色</legend>
                  <div>
                    {groupColors.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={avatarColor === color ? "is-selected" : ""}
                        style={{ backgroundColor: color }}
                        onClick={() => setAvatarColor(color)}
                        aria-label={`选择颜色 ${color}`}
                      >
                        {avatarColor === color && <Check size={12} />}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <button
                  type="button"
                  className="settings-submit"
                  disabled={busy === "profile" || name.trim().length < 2}
                  onClick={() => void saveProfile()}
                >
                  {busy === "profile" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  保存群资料
                </button>
              </>
            )}
          </section>

          <section className="group-members-card">
            <div className="manage-section-title">
              <span>
                <strong>群成员</strong>
                <small>{conversation.onlineMemberCount} 人在线</small>
              </span>
              <b>{conversation.memberCount}/50</b>
            </div>
            <div className="managed-member-list">
              {conversation.members.map((member) => {
                const memberIsOwner = member.id === conversation.ownerId;
                return (
                  <div key={member.id}>
                    <Avatar
                      name={member.displayName}
                      color={member.avatarColor}
                      size="small"
                      online={member.online}
                    />
                    <span>
                      <strong>{member.displayName}</strong>
                      <small>
                        @{member.username}
                        {member.id === currentUser.id ? " · 你" : ""}
                      </small>
                    </span>
                    {memberIsOwner ? (
                      <em>
                        <Crown size={12} /> 群主
                      </em>
                    ) : isOwner ? (
                      <span className="member-admin-actions">
                        <button
                          type="button"
                          title="转让群主"
                          onClick={() => setConfirmation({ type: "TRANSFER", user: member })}
                        >
                          <Crown size={14} />
                        </button>
                        <button
                          type="button"
                          title="移出群聊"
                          onClick={() => setConfirmation({ type: "REMOVE", user: member })}
                        >
                          <UserMinus size={14} />
                        </button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          {isOwner && (
            <section className="add-member-card">
              <div className="manage-section-title">
                <span>
                  <strong>添加成员</strong>
                  <small>只能添加当前可用的局域网账号</small>
                </span>
              </div>
              <label className="group-member-search">
                <Search size={15} />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索可添加联系人"
                />
                <span>已选 {selectedIds.length}</span>
              </label>
              <div className="group-member-list compact-list">
                {availableUsers.length ? (
                  availableUsers.map((candidate) => {
                    const selected = selectedIds.includes(candidate.id);
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        className={selected ? "is-selected" : ""}
                        onClick={() =>
                          setSelectedIds((current) =>
                            selected
                              ? current.filter((id) => id !== candidate.id)
                              : [...current, candidate.id],
                          )
                        }
                      >
                        <Avatar
                          name={candidate.displayName}
                          color={candidate.avatarColor}
                          size="small"
                          online={candidate.online}
                        />
                        <span>
                          <strong>{candidate.displayName}</strong>
                          <small>@{candidate.username}</small>
                        </span>
                        <i>{selected && <Check size={13} />}</i>
                      </button>
                    );
                  })
                ) : (
                  <p className="member-empty">暂无可添加的联系人</p>
                )}
              </div>
              <button
                type="button"
                className="settings-submit secondary"
                disabled={busy === "add" || selectedIds.length === 0}
                onClick={() => void addMembers()}
              >
                {busy === "add" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <UserPlus size={15} />
                )}
                添加所选成员
              </button>
            </section>
          )}

          <section className="group-danger-card">
            <button type="button" onClick={() => setConfirmation({ type: "LEAVE" })}>
              <DoorOpen size={16} />
              <span>
                <strong>退出群聊</strong>
                <small>不再接收此群的消息</small>
              </span>
            </button>
            {isOwner && (
              <button type="button" onClick={() => setConfirmation({ type: "DISBAND" })}>
                <Trash2 size={16} />
                <span>
                  <strong>解散群聊</strong>
                  <small>永久删除群聊和历史消息</small>
                </span>
              </button>
            )}
          </section>
        </div>

        {error && <div className="settings-notice error">{error}</div>}
        {confirmationCopy && (
          <div className="action-confirm">
            <div>
              <strong>{confirmationCopy.title}</strong>
              <small>{confirmationCopy.detail}</small>
            </div>
            <span>
              <button type="button" onClick={() => setConfirmation(null)} disabled={Boolean(busy)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void confirmAction()}
                disabled={Boolean(busy)}
              >
                {busy && <LoaderCircle className="spin" size={14} />}
                {confirmationCopy.action}
              </button>
            </span>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
