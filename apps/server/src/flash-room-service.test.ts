import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedFlashRoomExpiry, isFlashRoomExpired } from "./flash-room-service.js";

test("flash room expiry is constrained to a short collaboration window", () => {
  const now = new Date("2026-08-13T02:00:00.000Z");
  assert.equal(isAllowedFlashRoomExpiry(new Date("2026-08-13T02:30:00.000Z"), now), true);
  assert.equal(isAllowedFlashRoomExpiry(new Date("2026-08-13T02:04:59.000Z"), now), false);
  assert.equal(isAllowedFlashRoomExpiry(new Date("2026-08-20T02:00:01.000Z"), now), false);
});

test("only a room with a reached expiry is read-only", () => {
  const now = new Date("2026-08-13T02:00:00.000Z");
  assert.equal(isFlashRoomExpired(null, now), false);
  assert.equal(isFlashRoomExpired("2026-08-13T02:00:01.000Z", now), false);
  assert.equal(isFlashRoomExpired("2026-08-13T02:00:00.000Z", now), true);
});
