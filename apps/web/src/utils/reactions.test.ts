import { describe, expect, it } from "vitest";
import { MESSAGE_REACTION_OPTIONS, reactionTooltip } from "./reactions";

describe("message reaction options", () => {
  it("提供六种固定反应并用成员名生成聚合说明", () => {
    expect(MESSAGE_REACTION_OPTIONS).toHaveLength(6);
    expect(
      reactionTooltip({
        emoji: "🎉",
        count: 2,
        users: [
          { id: "one", displayName: "林小满" },
          { id: "two", displayName: "周远" },
        ],
      }),
    ).toBe("林小满、周远 · 庆祝");
  });
});
