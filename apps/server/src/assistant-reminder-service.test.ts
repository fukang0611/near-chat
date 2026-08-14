import assert from "node:assert/strict";
import test from "node:test";
import {
  reminderStatus,
  validateReminderSchedule,
} from "./assistant/assistant-reminder-service.js";
import { ApiError } from "./http.js";

test("提醒按完成、到期和待办状态稳定分类", () => {
  const now = new Date("2026-08-15T02:00:00.000Z");
  assert.equal(
    reminderStatus({ completed_at: null, scheduled_at: new Date("2026-08-15T02:00:01.000Z") }, now),
    "PENDING",
  );
  assert.equal(
    reminderStatus({ completed_at: null, scheduled_at: new Date("2026-08-15T02:00:00.000Z") }, now),
    "DUE",
  );
  assert.equal(
    reminderStatus(
      {
        completed_at: new Date("2026-08-15T01:00:00.000Z"),
        scheduled_at: new Date("2026-08-15T03:00:00.000Z"),
      },
      now,
    ),
    "COMPLETED",
  );
});

test("提醒时间必须位于两秒后到一年内", () => {
  const now = new Date("2026-08-15T02:00:00.000Z");
  assert.doesNotThrow(() => validateReminderSchedule(new Date("2026-08-15T02:00:03.000Z"), now));
  assert.throws(
    () => validateReminderSchedule(new Date("2026-08-15T02:00:02.000Z"), now),
    (error) => error instanceof ApiError && error.status === 400,
  );
  assert.throws(
    () => validateReminderSchedule(new Date("2027-08-17T02:00:00.000Z"), now),
    (error) => error instanceof ApiError && error.status === 400,
  );
});
