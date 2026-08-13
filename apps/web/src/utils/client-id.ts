const UUID_BYTE_LENGTH = 16;

function formatUuidV4(bytes: Uint8Array): string {
  // RFC 4122 UUID v4：第 7 个字节写入版本号，第 9 个字节写入 variant。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成消息发送幂等键。
 *
 * `crypto.randomUUID` 只在安全上下文中可用，使用 HTTP 局域网地址访问时浏览器
 * 可能不会暴露该方法；`getRandomValues` 可以在这种环境下继续生成标准 UUID v4。
 */
export function createClientMessageId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("当前浏览器不支持生成消息标识，请升级浏览器后重试");
  }

  return formatUuidV4(cryptoApi.getRandomValues(new Uint8Array(UUID_BYTE_LENGTH)));
}
