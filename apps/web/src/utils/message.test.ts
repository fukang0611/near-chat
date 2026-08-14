import { describe, expect, it } from "vitest";
import { appendMessageDraft, MAX_MESSAGE_TEXT_LENGTH } from "./message";

describe("message draft composition", () => {
  it("appends AI output with a readable paragraph boundary", () => {
    expect(appendMessageDraft("已有草稿  ", "AI 结果")).toBe("已有草稿\n\nAI 结果");
  });

  it("rejects oversized content instead of truncating it", () => {
    expect(appendMessageDraft("", "长".repeat(MAX_MESSAGE_TEXT_LENGTH + 1))).toBeNull();
  });
});
