import {
  Activity,
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
import type { AvatarPreset } from "../avatar-presets";
import type { FileQuota, User } from "../types";
import { errorMessage } from "../utils/errors";
import { formatBytes } from "../utils/format";
import {
  getNotificationCapability,
  type NotificationPreferences,
  playMessageSound,
  requestNotificationPermission,
} from "../utils/notifications";
import { Avatar } from "./Avatar";
import { AvatarPresetPicker } from "./AvatarPresetPicker";
import { UserStatusBubble } from "./UserStatusBubble";

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
const statusPresets = [
  { emoji: "🎯", text: "专注中" },
  { emoji: "📅", text: "开会中" },
  { emoji: "☕", text: "午休" },
  { emoji: "🚶", text: "外出" },
] as const;
type StatusDuration = "30" | "60" | "240" | "today";

function statusExpiry(duration: StatusDuration): string {
  const now = new Date();
  if (duration !== "today") {
    return new Date(now.getTime() + Number(duration) * 60_000).toISOString();
  }
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return new Date(Math.max(endOfDay.getTime(), now.getTime() + 60_000)).toISOString();
}

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
  const [selectingPresetId, setSelectingPresetId] = useState<string | null>(null);
  const [quota, setQuota] = useState<FileQuota | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [notificationCapability, setNotificationCapability] = useState(getNotificationCapability);
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [statusText, setStatusText] = useState(user.status?.text ?? "专注中");
  const [statusEmoji, setStatusEmoji] = useState(user.status?.emoji ?? "🎯");
  const [statusDuration, setStatusDuration] = useState<StatusDuration>("60");
  const [savingStatus, setSavingStatus] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .fileQuota()
      .then(setQuota)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !savingProfile &&
        !changingPassword &&
        !updatingAvatar &&
        !savingStatus &&
        !requestingNotifications
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [
    changingPassword,
    onClose,
    requestingNotifications,
    savingProfile,
    savingStatus,
    updatingAvatar,
  ]);

  useEffect(
    () => () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    },
    [avatarPreviewUrl],
  );

  const uploadAvatar = async (file: File | undefined, successText?: string) => {
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
        text: successText ?? (file.type === "image/gif" ? "GIF 动态头像已更新" : "头像已更新"),
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "头像上传失败") });
    } finally {
      setAvatarPreviewUrl(null);
      setUpdatingAvatar(false);
    }
  };

  const selectPresetAvatar = async (preset: AvatarPreset) => {
    setSelectingPresetId(preset.id);
    setUpdatingAvatar(true);
    setNotice(null);
    try {
      const response = await fetch(preset.src);
      if (!response.ok) throw new Error("预设头像读取失败");
      const blob = await response.blob();
      const file = new File([blob], `${preset.id}.gif`, { type: "image/gif" });
      await uploadAvatar(file, `已应用“${preset.label}”动态头像`);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "预设头像应用失败") });
    } finally {
      setUpdatingAvatar(false);
      setSelectingPresetId(null);
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
    setRequestingNotifications(true);
    try {
      const result = await requestNotificationPermission();
      setNotificationCapability(getNotificationCapability());
      if (!result.granted) {
        setNotice({ tone: "error", text: result.message });
        return;
      }
      onNotificationPreferencesChanged({ ...notificationPreferences, desktop: true });
      setNotice({ tone: "success", text: result.message });
    } finally {
      setRequestingNotifications(false);
    }
  };

  const toggleSound = () => {
    const enabled = !notificationPreferences.sound;
    onNotificationPreferencesChanged({ ...notificationPreferences, sound: enabled });
    if (enabled) void playMessageSound().catch(() => undefined);
  };

  const saveStatus = async () => {
    if (!statusText.trim()) return;
    setSavingStatus(true);
    setNotice(null);
    try {
      const result = await api.updateStatus({
        text: statusText.trim(),
        emoji: statusEmoji,
        expiresAt: statusExpiry(statusDuration),
      });
      onUpdated(result.user);
      setNotice({ tone: "success", text: "状态已同步给身边的伙伴" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "状态设置失败") });
    } finally {
      setSavingStatus(false);
    }
  };

  const clearStatus = async () => {
    setSavingStatus(true);
    setNotice(null);
    try {
      const result = await api.clearStatus();
      onUpdated(result.user);
      setNotice({ tone: "success", text: "状态已清除" });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error, "状态清除失败") });
    } finally {
      setSavingStatus(false);
    }
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
          !updatingAvatar &&
          !savingStatus &&
          !requestingNotifications
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
            disabled={
              savingProfile ||
              changingPassword ||
              updatingAvatar ||
              requestingNotifications ||
              savingStatus
            }
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
            <AvatarPresetPicker
              disabled={updatingAvatar}
              selectingId={selectingPresetId}
              onSelect={(preset) => void selectPresetAvatar(preset)}
            />
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

          <section className="settings-section status-settings-section">
            <div className="settings-section-heading">
              <Activity size={16} />
              <span>
                <strong>状态气泡</strong>
                <small>告诉伙伴你当下的节奏，到期后自动消失</small>
              </span>
              <UserStatusBubble status={user.status} compact />
            </div>
            <div className="status-preset-grid" role="group" aria-label="状态预设">
              {statusPresets.map((preset) => (
                <button
                  key={preset.text}
                  type="button"
                  className={statusText === preset.text ? "is-selected" : ""}
                  onClick={() => {
                    setStatusText(preset.text);
                    setStatusEmoji(preset.emoji);
                  }}
                >
                  <span>{preset.emoji}</span>
                  {preset.text}
                </button>
              ))}
            </div>
            <label className="settings-field status-text-field">
              <span>自定义状态</span>
              <span>
                <b aria-hidden="true">{statusEmoji}</b>
                <input
                  value={statusText}
                  onChange={(event) => setStatusText(event.target.value)}
                  maxLength={40}
                  placeholder="例如：整理需求中"
                />
              </span>
            </label>
            <div className="status-duration-row" role="group" aria-label="状态持续时间">
              {(
                [
                  ["30", "30 分钟"],
                  ["60", "1 小时"],
                  ["240", "4 小时"],
                  ["today", "今天结束"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={statusDuration === value ? "is-selected" : ""}
                  onClick={() => setStatusDuration(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="status-setting-actions">
              {user.status && (
                <button type="button" onClick={() => void clearStatus()} disabled={savingStatus}>
                  清除状态
                </button>
              )}
              <button
                className="settings-submit"
                type="button"
                onClick={() => void saveStatus()}
                disabled={savingStatus || !statusText.trim()}
              >
                {savingStatus ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                设置状态
              </button>
            </div>
          </section>

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
              disabled={notificationCapability === "unsupported" || requestingNotifications}
              aria-pressed={notificationPreferences.desktop}
            >
              <span className="preference-icon">
                <Bell size={16} />
              </span>
              <span>
                <strong>桌面通知</strong>
                <small>
                  {requestingNotifications
                    ? "正在请求系统授权"
                    : notificationCapability === "denied"
                      ? "已被浏览器阻止"
                      : notificationCapability === "insecure"
                        ? "局域网 HTTP 页面不可申请，请使用 HTTPS 或桌面客户端"
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
