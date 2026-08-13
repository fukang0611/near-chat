import { contextBridge, ipcRenderer } from "electron";
import type { ServerConnectionResult, SetupState } from "./contracts";

contextBridge.exposeInMainWorld("nearChatSetup", {
  getState: (): Promise<SetupState> => ipcRenderer.invoke("desktop:get-setup-state"),
  testServer: (serverUrl: string): Promise<ServerConnectionResult> =>
    ipcRenderer.invoke("desktop:test-server", serverUrl),
  connectServer: (serverUrl: string): Promise<ServerConnectionResult> =>
    ipcRenderer.invoke("desktop:connect-server", serverUrl),
});
