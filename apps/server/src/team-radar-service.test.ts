import assert from "node:assert/strict";
import test from "node:test";
import { teamDayWindow } from "./team-radar-service.js";

test("team radar uses the browser timezone for today's UTC window", () => {
  const now = new Date("2026-08-13T12:34:56.000Z");

  const shanghai = teamDayWindow(-480, now);
  assert.equal(shanghai.start.toISOString(), "2026-08-12T16:00:00.000Z");
  assert.equal(shanghai.end.toISOString(), "2026-08-13T16:00:00.000Z");

  const newYork = teamDayWindow(300, now);
  assert.equal(newYork.start.toISOString(), "2026-08-13T05:00:00.000Z");
  assert.equal(newYork.end.toISOString(), "2026-08-14T05:00:00.000Z");
});
