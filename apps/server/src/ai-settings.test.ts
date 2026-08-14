import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decryptAiSecret, encryptAiSecret } from "./ai/ai-settings-service.js";

describe("AI 设置密钥保护", () => {
  it("可使用同一管理密钥加解密且不会保存明文", () => {
    const plain = "sk-near-chat-private";
    const encrypted = encryptAiSecret(plain, "unit-test-encryption-key");

    assert.ok(encrypted.startsWith("v1:"));
    assert.ok(!encrypted.includes(plain));
    assert.equal(decryptAiSecret(encrypted, "unit-test-encryption-key"), plain);
  });

  it("相同密钥每次产生不同密文，错误管理密钥无法解密", () => {
    const first = encryptAiSecret("same-secret", "correct-key");
    const second = encryptAiSecret("same-secret", "correct-key");

    assert.notEqual(first, second);
    assert.throws(() => decryptAiSecret(first, "wrong-key"));
  });

  it("拒绝被篡改或无法识别的密文", () => {
    const encrypted = encryptAiSecret("secret", "correct-key");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    assert.throws(() => decryptAiSecret(tampered, "correct-key"));
    assert.throws(() => decryptAiSecret("plain-text", "correct-key"));
  });
});
