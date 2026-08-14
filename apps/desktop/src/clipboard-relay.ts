import type { DesktopClipboardRelayPayload } from "./contracts";

export const CLIPBOARD_RELAY_ACCELERATOR = "CommandOrControl+Shift+V";
export const CLIPBOARD_RELAY_MAX_TEXT_LENGTH = 5_000;
export const CLIPBOARD_RELAY_MAX_IMAGE_BYTES = 500 * 1024 * 1024;

interface ClipboardRelaySnapshot {
  id: string;
  text: string;
  imagePng: Uint8Array | null;
  capturedAt: string;
}

/** 将 Electron 剪贴板快照压缩成可安全跨越预加载桥的有限数据。 */
export function buildClipboardRelayPayload(
  snapshot: ClipboardRelaySnapshot,
): DesktopClipboardRelayPayload {
  const normalizedText = snapshot.text.trim();
  const textTooLong = normalizedText.length > CLIPBOARD_RELAY_MAX_TEXT_LENGTH;
  const text = normalizedText ? normalizedText.slice(0, CLIPBOARD_RELAY_MAX_TEXT_LENGTH + 1) : null;
  const imageTooLarge = (snapshot.imagePng?.byteLength ?? 0) > CLIPBOARD_RELAY_MAX_IMAGE_BYTES;
  const imagePng = imageTooLarge ? null : snapshot.imagePng;
  const imageDataUrl = imagePng
    ? `data:image/png;base64,${Buffer.from(imagePng).toString("base64")}`
    : null;

  let issue: string | null = null;
  if (imageTooLarge) issue = "剪贴板图片超过 500 MB，无法发送";
  else if (textTooLong) issue = "剪贴板文字超过 5000 个字符，请缩短后重试";
  else if (!text && !imageDataUrl) issue = "剪贴板中没有可发送的文字或图片";

  return {
    id: snapshot.id,
    text,
    imageDataUrl,
    imageSizeBytes: imagePng?.byteLength ?? null,
    capturedAt: snapshot.capturedAt,
    issue,
  };
}
