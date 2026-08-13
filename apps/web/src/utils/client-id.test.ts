import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientMessageId } from "./client-id";

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function mockCrypto(value: Partial<Crypto>) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
}

describe("createClientMessageId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      delete (globalThis as { crypto?: Crypto }).crypto;
    }
  });

  it("优先使用浏览器原生 randomUUID", () => {
    const randomUUID = vi.fn(() => "0f30c282-4a74-49f0-8feb-7a2b50e87e29");
    mockCrypto({ randomUUID } as Partial<Crypto>);

    expect(createClientMessageId()).toBe("0f30c282-4a74-49f0-8feb-7a2b50e87e29");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("HTTP 局域网环境缺少 randomUUID 时生成标准 UUID v4", () => {
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return target;
    });
    mockCrypto({ getRandomValues } as Partial<Crypto>);

    expect(createClientMessageId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
