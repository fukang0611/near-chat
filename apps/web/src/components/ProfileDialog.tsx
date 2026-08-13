import {
  Bell,
  Check,
  HardDrive,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  Palette,
  Trash2,
  UserRoundCog,
  Volume2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { FileQuota, User } from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";
import { type NotificationPreferences, playMessageSound } from "../utils/notifications";
import { Avatar } from "./Avatar";

interface ProfileDialogProps {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onPasswordChanged: () => void;
  notificationPreferences: NotificationPreferences;
  onNotificationPreferencesChanged: (preferences: NotificationPreferences) => void;
}

const avatarPalette = ["#6757E8", "#E76F88", "#2FA98C", "#E08A45", "#4A86D8", "#9A63C7"];
const avatarContentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

/** 个人资料、存储用量和密码安全集中在一个自助设置面板中。 */
export function ProfileDialog({
  user,
  onClose,
  onUpdated,
  onPasswordChanged,
  notificationPreferences,
  onNotificationPreferencesChanged,
}: ProfileDialogProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [updatingAvatar, setUpdatingAvatar] = useState(false);
  const [quota, setQuota] = useState<FileQuota | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >(() => ("Notification" in window ? Notification.permission : "unsupported"));
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .fileQuota()
      .then(setQuota)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingProfile && !changingPassword && !updatingAvatar) {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [changingPassword, onClose, savingProfile, updatingAvatar]);

  useEffect(
    () => () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    },
    [avatarPreviewUrl],
  );

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    if (!avatarContentTypes.has(file.type)) {
      setNotice({ tone: "error", text: "头像仅支持 GIF、PNG、JPG 和 WebP 图片" });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setNotice({ tone: "error", text: "头像不能超过 8 MB" });
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setAvatarPreviewUrl(previewUrl);
    setUpdatingAvatar(true);
    setNotice(null);
    try {
      const result = await api.uploadAvatar(file);
      onUpdated(result.user);
      setNotice({
        tone: "success",
        text: file.type === "image/gif" ? "GIF 动态头像已更新" : "头像已更新",
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "头像上传失败") });
    } finally {
      setAvatarPreviewUrl(null);
      setUpdatingAvatar(false);
    }
  };

  const removeAvatar = async () => {
    setUpdatingAvatar(true);
    setNotice(null);
    try {
      const result = await api.deleteAvatar();
      onUpdated(result.user);
      setNotice({ tone: "success", text: "已恢复为文字头像" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "头像移除失败") });
    } finally {
      setUpdatingAvatar(false);
    }
  };

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

  const toggleDesktopNotifications = async () => {
    if (notificationPreferences.desktop) {
      onNotificationPreferencesChanged({ ...notificationPreferences, desktop: false });
      return;
    }
    if (!("Notification" in window)) {
      setNotice({ tone: "error", text: "当前浏览器不支持桌面通知" });
      return;
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    setNotificationPermission(permission);
    if (permission !== "granted") {
      setNotice({ tone: "error", text: "浏览器未授予通知权限，请在站点设置中开启" });
      return;
    }
    onNotificationPreferencesChanged({ ...notificationPreferences, desktop: true });
    setNotice({ tone: "success", text: "桌面通知已开启" });
  };

  const toggleSound = () => {
    const enabled = !notificationPreferences.sound;
    onNotificationPreferencesChanged({ ...notificationPreferences, sound: enabled });
    if (enabled) void playMessageSound().catch(() => undefined);
  };

  return createPortal(
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !savingProfile &&
          !changingPassword &&
          !updatingAvatar
        ) {
          onClose();
        }
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
          <button
            type="button"
            onClick={onClose}
            disabled={savingProfile || changingPassword || updatingAvatar}
            aria-label="关闭个人设置"
          >
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
            <div className="avatar-editor">
              <button
                className="avatar-editor-preview"
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={updatingAvatar}
                aria-label={user.avatarUrl ? "更换头像" : "上传头像"}
              >
                <Avatar
                  name={displayName || user.username}
                  color={avatarColor}
                  src={avatarPreviewUrl ?? user.avatarUrl}
                  size="large"
                />
                <span>
                  {updatingAvatar ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ImagePlus size={16} />
                  )}
                </span>
              </button>
              <span className="avatar-editor-copy">
                <strong>{displayName || "未命名用户"}</strong>
                <small>GIF、PNG、JPG 或 WebP · 最大 8 MB</small>
                <span className="avatar-editor-actions">
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={updatingAvatar}
                  >
                    <ImagePlus size={13} />
                    {user.avatarUrl ? "更换图片" : "选择图片"}
                  </button>
                  {user.avatarUrl && (
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => void removeAvatar()}
                      disabled={updatingAvatar}
                    >
                      <Trash2 size={13} />
                      移除
                    </button>
                  )}
                </span>
              </span>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/gif,image/jpeg,image/png,image/webp"
                aria-label="选择头像文件"
                hidden
                onChange={(event) => {
                  void uploadAvatar(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
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
              disabled={savingProfile || updatingAvatar || !displayName.trim()}
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

          <section className="settings-section notification-section">
            <div className="settings-section-heading">
              <Bell size={16} />
              <span>
                <strong>消息提醒</strong>
                <small>仅保存在当前浏览器，不会同步到其他设备</small>
              </span>
            </div>
            <button
              className="preference-row"
              type="button"
              onClick={() => void toggleDesktopNotifications()}
              disabled={notificationPermission === "unsupported"}
              aria-pressed={notificationPreferences.desktop}
            >
              <span className="preference-icon">
                <Bell size={16} />
              </span>
              <span>
                <strong>桌面通知</strong>
                <small>
                  {notificationPermission === "denied"
                    ? "已被浏览器阻止"
                    : "应用不在前台时显示新消息"}
                </small>
              </span>
              <i className={notificationPreferences.desktop ? "is-on" : ""} aria-hidden="true">
                <b />
              </i>
            </button>
            <button
              className="preference-row"
              type="button"
              onClick={toggleSound}
              aria-pressed={notificationPreferences.sound}
            >
              <span className="preference-icon">
                <Volume2 size={16} />
              </span>
              <span>
                <strong>消息提示音</strong>
                <small>收到非当前会话消息时播放轻提示音</small>
              </span>
              <i className={notificationPreferences.sound ? "is-on" : ""} aria-hidden="true">
                <b />
              </i>
            </button>
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
