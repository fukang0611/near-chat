import assert from "node:assert/strict";
import test from "node:test";
import { replaceReminderSchedule, shouldScheduleReminder } from "../src/notification-policy.ts";

const reminder = {
  id: "reminder-1",
  title: "提醒",
  note: "",
  scheduledAt: "2026-08-22T00:00:00.000Z",
  completedAt: null,
  notifiedAt: null,
  revision: 1,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

test("完成、无效或已过期的远端提醒必须进入取消分支", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  assert.equal(shouldScheduleReminder(reminder, now), true);
  assert.equal(
    shouldScheduleReminder({ ...reminder, completedAt: reminder.updatedAt }, now),
    false,
  );
  assert.equal(shouldScheduleReminder({ ...reminder, scheduledAt: "not-a-date" }, now), false);
  assert.equal(
    shouldScheduleReminder({ ...reminder, scheduledAt: "2026-08-21T11:59:59.999Z" }, now),
    false,
  );
});

test("重新调度先取消旧通知，权限拒绝时不会保留或创建 alarm", async () => {
  const calls: string[] = [];
  const scheduled = await replaceReminderSchedule(reminder, {
    async cancel() {
      calls.push("cancel");
    },
    async ensurePermission() {
      calls.push("permission");
      return false;
    },
    canSchedule() {
      calls.push("native");
      return true;
    },
    async schedule() {
      calls.push("schedule");
    },
  });
  assert.equal(scheduled, false);
  assert.deepEqual(calls, ["cancel", "permission"]);
});
