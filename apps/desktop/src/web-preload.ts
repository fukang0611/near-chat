import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopClipboardRelayPayload,
  DesktopClipboardRelayStatus,
  DesktopNotificationInput,
  DesktopNotificationPermissionResult,
} from "./contracts";

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.nearChatDesktop = "true";
});

contextBridge.exposeInMainWorld("nearChatDesktop", {
  platform: process.platform,
  openServerSettings: (): Promise<void> => ipcRenderer.invoke("desktop:open-server-settings"),
  requestNotificationPermission: (): Promise<DesktopNotificationPermissionResult> =>
    ipcRenderer.invoke("desktop:request-notification-permission"),
  showNotification: (input: DesktopNotificationInput): Promise<boolean> =>
    ipcRenderer.invoke("desktop:show-notification", input),
  getClipboardRelayStatus: (): Promise<DesktopClipboardRelayStatus> =>
    ipcRenderer.invoke("desktop:get-clipboard-relay-status"),
  requestClipboardRelay: (): Promise<void> => ipcRenderer.invoke("desktop:request-clipboard-relay"),
  onClipboardRelay: (listener: (payload: DesktopClipboardRelayPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopClipboardRelayPayload) => {
      listener(payload);
    };
    ipcRenderer.on("desktop:clipboard-relay", handler);
    return () => ipcRenderer.removeListener("desktop:clipboard-relay", handler);
  },
  onNotificationClick: (listener: (conversationId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, conversationId: string) => {
      listener(conversationId);
    };
    ipcRenderer.on("desktop:notification-clicked", handler);
    return () => ipcRenderer.removeListener("desktop:notification-clicked", handler);
  },
});
