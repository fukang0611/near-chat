import { BellRing, Check, Laptop, ShieldCheck, X } from "lucide-react";
import { createPortal } from "react-dom";
import { getNotificationCapability } from "../utils/notifications";

interface NotificationPermissionPromptProps {
  busy: boolean;
  message: string | null;
  onEnable: () => void;
  onDismiss: () => void;
}

/**
 * 页面可自动展示说明层，但系统权限框必须由用户点击触发。
 * 这层交互既满足浏览器限制，也让用户在授权前明确知道权限用途。
 */
export function NotificationPermissionPrompt({
  busy,
  message,
  onEnable,
  onDismiss,
}: NotificationPermissionPromptProps) {
  const capability = getNotificationCapability();
  const requestable = ["desktop", "granted", "prompt"].includes(capability);
  const isElectron = capability === "desktop";

  const description = isElectron
    ? "允许近聊在窗口最小化或切换到其他应用时，通过本机系统通知提醒你。"
    : capability === "insecure"
      ? "当前是局域网 HTTP 地址，浏览器不会开放系统通知权限。使用 HTTPS 或桌面客户端即可启用。"
      : capability === "denied"
        ? "浏览器已阻止该站点的通知。需要先在地址栏的站点设置中改为“允许”。"
        : capability === "unsupported"
          ? "当前浏览器或系统不支持桌面通知，你仍然可以正常使用站内未读提醒。"
          : "允许近聊在页面不活跃时显示新消息提醒。消息正文仍只在你的局域网内流转。";

  return createPortal(
    <div className="notification-permission-layer" role="presentation">
      <section
        className="notification-permission-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-permission-title"
      >
        <button
          className="notification-permission-close"
          type="button"
          onClick={onDismiss}
          disabled={busy}
          aria-label="暂不开启通知"
        >
          <X size={17} />
        </button>
        <span className="notification-permission-symbol" aria-hidden="true">
          <i />
          <BellRing size={27} />
        </span>
        <div className="notification-permission-copy">
          <small>{isElectron ? "系统通知" : "浏览器通知"}</small>
          <h2 id="notification-permission-title">不错过团队的新消息</h2>
          <p>{description}</p>
        </div>
        <div className="notification-permission-facts" aria-label="权限说明">
          <span>
            <ShieldCheck size={15} /> 仅用于新消息提醒
          </span>
          <span>
            <Laptop size={15} /> 可随时在个人设置中关闭
          </span>
        </div>
        {message && <div className="notification-permission-message">{message}</div>}
        <div className="notification-permission-actions">
          <button type="button" className="secondary" onClick={onDismiss} disabled={busy}>
            {requestable ? "暂不开启" : "知道了"}
          </button>
          {requestable && (
            <button type="button" className="primary" onClick={onEnable} disabled={busy}>
              {busy ? <i className="permission-spinner" /> : <Check size={16} />}
              {busy ? "正在请求" : "开启通知"}
            </button>
          )}
        </div>
        <small className="notification-permission-footnote">
          {requestable ? "点击后将由浏览器或操作系统显示正式授权框" : "近聊无法绕过系统权限设置"}
        </small>
      </section>
    </div>,
    document.body,
  );
}
