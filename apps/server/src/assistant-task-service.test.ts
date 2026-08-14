import assert from "node:assert/strict";
import test from "node:test";
import { nextAssistantTaskRun } from "./assistant/assistant-task-schedule.js";

test("一次性助理任务执行后不再生成下一次时间", () => {
  const scheduledFor = new Date("2026-08-14T02:00:00.000Z");
  assert.equal(nextAssistantTaskRun("ONCE", scheduledFor), null);
});

test("每日助理任务按固定周期生成下一次时间", () => {
  const scheduledFor = new Date("2026-08-14T02:00:00.000Z");
  const next = nextAssistantTaskRun("DAILY", scheduledFor, new Date("2026-08-14T02:00:01.000Z"));
  assert.equal(next?.toISOString(), "2026-08-15T02:00:00.000Z");
});

test("周期助理任务跳过停机期间错过的执行点", () => {
  const scheduledFor = new Date("2026-08-01T02:00:00.000Z");
  const next = nextAssistantTaskRun("WEEKLY", scheduledFor, new Date("2026-08-14T03:00:00.000Z"));
  assert.equal(next?.toISOString(), "2026-08-15T02:00:00.000Z");
});
