import { Check, HardDrive, KeyRound, LoaderCircle, Palette, UserRoundCog, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { FileQuota, User } from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";
import { Avatar } from "./Avatar";

interface ProfileDialogProps {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onPasswordChanged: () => void;
}

const avatarPalette = ["#6757E8", "#E76F88", "#2FA98C", "#E08A45", "#4A86D8", "#9A63C7"];

/** 个人资料、存储用量和密码安全集中在一个自助设置面板中。 */
export function ProfileDialog({ user, onClose, onUpdated, onPasswordChanged }: ProfileDialogProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [quota, setQuota] = useState<FileQuota | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    void api
      .fileQuota()
      .then(setQuota)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingProfile && !changingPassword) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [changingPassword, onClose, savingProfile]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSavingProfile(true);
    setNotice(null);
    try {
      const result = await api.updateProfile({ displayName: displayName.trim(), avatarColor });
      onUpdated(result.user);
      setNotice({ tone: "success", text: "个人资料已保存" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "个人资料保存失败") });
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setNotice({ tone: "error", text: "两次输入的新密码不一致" });
      return;
    }
    setChangingPassword(true);
    setNotice(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      onPasswordChanged();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "密码修改失败") });
      setChangingPassword(false);
    }
  };

  const quotaPercent = quota ? Math.min(100, (quota.usedBytes / quota.quotaBytes) * 100) : 0;

  return createPortal(
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !savingProfile && !changingPassword) onClose();
      }}
    >
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
      >
        <header>
          <span className="dialog-symbol">
            <UserRoundCog size={20} />
          </span>
          <div>
            <strong id="profile-title">个人设置</strong>
            <small>管理你的公开资料、文件空间与登录密码</small>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭个人设置">
            <X size={18} />
          </button>
        </header>

        <div className="settings-scroll">
          <form className="settings-section" onSubmit={saveProfile}>
            <div className="settings-section-heading">
              <Palette size={16} />
              <span>
                <strong>公开资料</strong>
                <small>群成员与联系人会看到这些信息</small>
              </span>
            </div>
            <div className="profile-preview">
              <Avatar name={displayName || user.username} color={avatarColor} />
              <span>
                <strong>{displayName || "未命名用户"}</strong>
                <small>@{user.username}</small>
              </span>
            </div>
            <label className="settings-field">
              <span>显示名称</span>
              <input
                autoFocus
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={80}
                required
              />
            </label>
            <fieldset className="color-picker">
              <legend>头像颜色</legend>
              <div>
                {avatarPalette.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={avatarColor === color ? "is-selected" : ""}
                    style={{ backgroundColor: color }}
                    onClick={() => setAvatarColor(color)}
                    aria-label={`选择颜色 ${color}`}
                    aria-pressed={avatarColor === color}
                  >
                    {avatarColor === color && <Check size={13} />}
                  </button>
                ))}
              </div>
            </fieldset>
            <button
              className="settings-submit"
              type="submit"
              disabled={savingProfile || !displayName.trim()}
            >
              {savingProfile ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              保存资料
            </button>
          </form>

          <section className="settings-section quota-section">
            <div className="settings-section-heading">
              <HardDrive size={16} />
              <span>
                <strong>文件空间</strong>
                <small>已发送与待发送附件共用个人配额</small>
              </span>
            </div>
            {quota ? (
              <>
                <div className="quota-copy">
                  <strong>{formatBytes(quota.usedBytes)}</strong>
                  <span>共 {formatBytes(quota.quotaBytes)}</span>
                </div>
                <div className="quota-track" aria-label={`已使用 ${quotaPercent.toFixed(1)}%`}>
                  <i style={{ width: `${quotaPercent}%` }} />
                </div>
                <small className="quota-remaining">剩余 {formatBytes(quota.remainingBytes)}</small>
              </>
            ) : (
              <div className="quota-loading">
                <LoaderCircle className="spin" size={15} /> 正在读取空间用量
              </div>
            )}
          </section>

          <form className="settings-section password-section" onSubmit={changePassword}>
            <div className="settings-section-heading">
              <KeyRound size={16} />
              <span>
                <strong>修改密码</strong>
                <small>修改成功后，所有设备都需要重新登录</small>
              </span>
            </div>
            <label className="settings-field">
              <span>当前密码</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={6}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label className="settings-field">
                <span>确认新密码</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={6}
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
            <button
              className="settings-submit secondary"
              type="submit"
              disabled={
                changingPassword || !currentPassword || newPassword.length < 6 || !confirmPassword
              }
            >
              {changingPassword ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <KeyRound size={15} />
              )}
              修改并重新登录
            </button>
          </form>
        </div>

        {notice && <div className={`settings-notice ${notice.tone}`}>{notice.text}</div>}
      </section>
    </div>,
    document.body,
  );
}
