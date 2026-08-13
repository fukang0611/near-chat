import { describe, expect, it } from "vitest";
import { messageKindFromContentType } from "./message-kind";

describe("messageKindFromContentType", () => {
  it("把音频附件识别为语音消息", () => {
    expect(messageKindFromContentType(null)).toBe("TEXT");
    expect(messageKindFromContentType("image/webp")).toBe("IMAGE");
    expect(messageKindFromContentType("audio/mp4")).toBe("AUDIO");
    expect(messageKindFromContentType("application/zip")).toBe("FILE");
  });
});
