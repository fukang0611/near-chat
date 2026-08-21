import assert from "node:assert/strict";
import test from "node:test";
import { ReminderCoordinator } from "../src/reminder-coordinator.ts";
import { applyRemoteSyncChange } from "../src/remote-sync-apply.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("在途 schedule 完成后删除仍以 cancel+remove 作为同一通知 ID 的最终状态", async () => {
  const coordinator = new ReminderCoordinator();
  const scheduling = deferred();
  const events: string[] = [];
  const reconcile = coordinator.reconcile(
    "reminder-a",
    async () => ({ id: "reminder-a" }),
    async () => {
      events.push("schedule:start");
      await scheduling.promise;
      events.push("schedule:end");
      return true;
    },
    async () => {
      events.push("cancel");
    },
  );
  const deleting = coordinator.cancelThen(
    "reminder-a",
    async () => {
      events.push("cancel");
    },
    async () => {
      events.push("remove");
    },
  );

  await Promise.resolve();
  scheduling.resolve();
  await Promise.all([reconcile, deleting]);
  assert.deepEqual(events, ["schedule:start", "schedule:end", "cancel", "remove"]);
});

test("账号迁移前后的相同 reminderId 共用一个物理通知队列", async () => {
  const coordinator = new ReminderCoordinator();
  const first = deferred();
  const events: string[] = [];
  const local = coordinator.reconcile(
    "same-id",
    async () => ({ id: "same-id", version: 1 }),
    async () => {
      events.push("local:start");
      await first.promise;
      events.push("local:end");
      return true;
    },
    async () => undefined,
  );
  const team = coordinator.reconcile(
    "same-id",
    async () => ({ id: "same-id", version: 2 }),
    async (reminder) => {
      events.push(`team:${reminder.version}`);
      return true;
    },
    async () => undefined,
  );

  first.resolve();
  await Promise.all([local, team]);
  assert.deepEqual(events, ["local:start", "local:end", "team:2"]);
});

test("远端 reminder DELETE 的 cancel 失败时不进入 Room settlement，行与 cursor 可重试", async () => {
  const coordinator = new ReminderCoordinator();
  let roomRowExists = true;
  const committedCursors: string[] = [];

  await assert.rejects(
    applyRemoteSyncChange(
      {
        sequence: "50",
        entityType: "PERSONAL_REMINDER",
        entityId: "reminder-crash-safe",
        operation: "DELETE",
        revision: 5,
        payload: {},
        occurredAt: "2026-08-21T00:05:00.000Z",
      },
      {
        settle: () =>
          coordinator.cancelThen(
            "reminder-crash-safe",
            async () => {
              throw new Error("notification service unavailable");
            },
            async () => {
              roomRowExists = false;
              committedCursors.push("50");
              return true;
            },
          ),
        reconcileReminder: async () => undefined,
      },
    ),
    /notification service unavailable/,
  );

  assert.equal(roomRowExists, true);
  assert.deepEqual(committedCursors, []);
});

test("远端 reminder DELETE 被新 outbox 阻断时，cancel 后重读 Room 恢复本地新 alarm", async () => {
  const coordinator = new ReminderCoordinator();
  const events: string[] = [];
  const current = { id: "reminder-blocked", scheduledAt: "2026-08-22T06:00:00.000Z" };

  const result = await applyRemoteSyncChange(
    {
      sequence: "51",
      entityType: "PERSONAL_REMINDER",
      entityId: current.id,
      operation: "DELETE",
      revision: 6,
      payload: {},
      occurredAt: "2026-08-21T00:06:00.000Z",
    },
    {
      settle: () =>
        coordinator.cancelThen(
          current.id,
          async () => {
            events.push("cancel:old");
          },
          async () => {
            events.push("settle:blocked");
            return false;
          },
        ),
      reconcileReminder: () =>
        coordinator
          .reconcile(
            current.id,
            async () => current,
            async (value) => {
              events.push(`schedule:${value.scheduledAt}`);
              return true;
            },
            async () => {
              events.push("cancel:missing");
            },
          )
          .then(() => undefined),
    },
  );

  assert.equal(result, "BLOCKED");
  assert.deepEqual(events, ["cancel:old", "settle:blocked", "schedule:2026-08-22T06:00:00.000Z"]);
});
