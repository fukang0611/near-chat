import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopClipboardRelayPayload,
  DesktopClipboardRelayStatus,
  DesktopIslandStatus,
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
  getDesktopIslandStatus: (): Promise<DesktopIslandStatus> =>
    ipcRenderer.invoke("desktop:get-island-status"),
  setDesktopIslandEnabled: (enabled: boolean): Promise<DesktopIslandStatus> =>
    ipcRenderer.invoke("desktop:set-island-enabled", enabled),
  openMainWindow: (conversationId?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:open-main-window", conversationId),
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
  onDesktopIslandStatusChanged: (listener: (status: DesktopIslandStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopIslandStatus) => {
      listener(status);
    };
    ipcRenderer.on("desktop:island-status-changed", handler);
    return () => ipcRenderer.removeListener("desktop:island-status-changed", handler);
  },
});
