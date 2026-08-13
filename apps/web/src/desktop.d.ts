interface NearChatDesktopBridge {
  readonly platform: "darwin" | "linux" | "win32";
  openServerSettings(): Promise<void>;
  requestNotificationPermission(): Promise<{
    granted: boolean;
    status: "granted" | "requested" | "unsupported" | "failed";
    message: string;
  }>;
  showNotification(input: {
    title: string;
    body: string;
    conversationId: string;
  }): Promise<boolean>;
  getClipboardRelayStatus(): Promise<DesktopClipboardRelayStatus>;
  requestClipboardRelay(): Promise<void>;
  onClipboardRelay(listener: (payload: DesktopClipboardRelayPayload) => void): () => void;
  onNotificationClick(listener: (conversationId: string) => void): () => void;
}

interface DesktopClipboardRelayPayload {
  id: string;
  text: string | null;
  imageDataUrl: string | null;
  imageSizeBytes: number | null;
  capturedAt: string;
  issue: string | null;
}

interface DesktopClipboardRelayStatus {
  registered: boolean;
  accelerator: string;
  message: string;
}

interface Window {
  readonly nearChatDesktop?: NearChatDesktopBridge;
}
