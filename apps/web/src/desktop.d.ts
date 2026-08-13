interface NearChatDesktopBridge {
  readonly platform: "darwin" | "linux" | "win32";
  openServerSettings(): Promise<void>;
  showNotification(input: {
    title: string;
    body: string;
    conversationId: string;
  }): Promise<boolean>;
  onNotificationClick(listener: (conversationId: string) => void): () => void;
}

interface Window {
  readonly nearChatDesktop?: NearChatDesktopBridge;
}
