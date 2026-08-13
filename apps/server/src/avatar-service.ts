export const avatarContentTypes = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;

export type AvatarContentType = (typeof avatarContentTypes)[number];

const extensions: Record<AvatarContentType, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** 只信任文件签名，不信任 multipart 声明的 MIME，避免把任意文件作为图片返回。 */
export function detectAvatarContentType(buffer: Buffer): AvatarContentType | null {
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function avatarExtension(contentType: AvatarContentType): string {
  return extensions[contentType];
}

/** URL 携带单调递增版本号，使头像更新后浏览器立即请求新资源。 */
export function publicAvatarUrl(
  userId: string,
  objectKey: string | null,
  version: number,
): string | null {
  return objectKey ? `/api/users/${userId}/avatar?v=${version}` : null;
}
