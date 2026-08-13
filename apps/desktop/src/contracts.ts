export interface SetupState {
  appVersion: string;
  currentServerUrl: string | null;
  defaultServerUrl: string;
  errorMessage: string | null;
}

export interface ServerConnectionResult {
  ok: boolean;
  serverUrl?: string;
  message?: string;
}

export interface DesktopNotificationInput {
  title: string;
  body: string;
  conversationId: string;
}

export interface DesktopNotificationPermissionResult {
  granted: boolean;
  status: "granted" | "requested" | "unsupported" | "failed";
  message: string;
}
