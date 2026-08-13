import assert from "node:assert/strict";
import test from "node:test";
import { isMessageReactionEmoji, MESSAGE_REACTION_EMOJIS } from "./reaction-service.js";

test("message reactions accept only the six product presets", () => {
  assert.equal(MESSAGE_REACTION_EMOJIS.length, 6);
  for (const emoji of MESSAGE_REACTION_EMOJIS) assert.equal(isMessageReactionEmoji(emoji), true);
  assert.equal(isMessageReactionEmoji("🔥"), false);
  assert.equal(isMessageReactionEmoji("<script>"), false);
});
