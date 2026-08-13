import assert from "node:assert/strict";
import test from "node:test";
import { activeUserStatus, isAllowedStatusExpiry } from "./status-service.js";

test("activeUserStatus hides incomplete and expired status records", () => {
  const now = new Date("2026-08-13T02:00:00.000Z");
  assert.equal(activeUserStatus("专注中", "🎯", "2026-08-13T01:59:59.000Z", now), null);
  assert.equal(activeUserStatus("专注中", null, "2026-08-13T03:00:00.000Z", now), null);
});

test("activeUserStatus serializes a currently active status", () => {
  const status = activeUserStatus(
    "开会中",
    "📅",
    new Date("2026-08-13T03:00:00.000Z"),
    new Date("2026-08-13T02:00:00.000Z"),
  );
  assert.deepEqual(status, {
    text: "开会中",
    emoji: "📅",
    expiresAt: "2026-08-13T03:00:00.000Z",
  });
});

test("isAllowedStatusExpiry accepts only near-term status durations", () => {
  const now = new Date("2026-08-13T02:00:00.000Z");
  assert.equal(isAllowedStatusExpiry(new Date("2026-08-13T02:30:00.000Z"), now), true);
  assert.equal(isAllowedStatusExpiry(new Date("2026-08-13T02:00:30.000Z"), now), false);
  assert.equal(isAllowedStatusExpiry(new Date("2026-08-14T02:00:01.000Z"), now), false);
});
