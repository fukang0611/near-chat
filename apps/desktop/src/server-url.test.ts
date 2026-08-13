import { describe, expect, it } from "vitest";
import { normalizeServerUrl, serverHealthUrl } from "./server-url";

describe("desktop server URL", () => {
  it("为局域网地址补全协议并移除末尾斜杠", () => {
    expect(normalizeServerUrl(" 192.168.10.20:3000/ ")).toBe("http://192.168.10.20:3000");
    expect(normalizeServerUrl("https://chat.example.local/")).toBe("https://chat.example.local");
  });

  it("生成稳定的健康检查地址", () => {
    expect(serverHealthUrl("10.0.0.8:8080")).toBe("http://10.0.0.8:8080/api/health");
  });

  it("拒绝危险协议、凭据和额外路径", () => {
    expect(() => normalizeServerUrl("file:///tmp/chat")).toThrow("仅支持 HTTP 或 HTTPS");
    expect(() => normalizeServerUrl("http://admin:secret@10.0.0.8:3000")).toThrow(
      "不能包含账号或密码",
    );
    expect(() => normalizeServerUrl("http://10.0.0.8:3000/chat")).toThrow("不能包含额外路径");
  });
});
