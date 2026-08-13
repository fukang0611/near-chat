import assert from "node:assert/strict";
import test from "node:test";
import { messageKindFromContentType } from "./message-kind.js";

test("message kind follows the stored attachment content type", () => {
  assert.equal(messageKindFromContentType(null), "TEXT");
  assert.equal(messageKindFromContentType("image/png"), "IMAGE");
  assert.equal(messageKindFromContentType("audio/webm"), "AUDIO");
  assert.equal(messageKindFromContentType("application/pdf"), "FILE");
});
