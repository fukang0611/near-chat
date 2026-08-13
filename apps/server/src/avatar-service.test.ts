import assert from "node:assert/strict";
import test from "node:test";
import { detectAvatarContentType, publicAvatarUrl } from "./avatar-service.js";

test("detectAvatarContentType detects supported image signatures", () => {
  assert.equal(detectAvatarContentType(Buffer.from("GIF89a", "ascii")), "image/gif");
  assert.equal(
    detectAvatarContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(detectAvatarContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectAvatarContentType(Buffer.from("RIFF0000WEBP", "ascii")), "image/webp");
});

test("detectAvatarContentType rejects declarations without a valid image signature", () => {
  assert.equal(detectAvatarContentType(Buffer.from("<svg onload='alert(1)' />")), null);
  assert.equal(detectAvatarContentType(Buffer.alloc(0)), null);
});

test("publicAvatarUrl changes with the stored avatar version", () => {
  assert.equal(publicAvatarUrl("user-id", null, 0), null);
  assert.equal(
    publicAvatarUrl("user-id", "avatars/user-id/avatar.gif", 3),
    "/api/users/user-id/avatar?v=3",
  );
});
