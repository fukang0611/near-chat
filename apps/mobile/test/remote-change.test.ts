import assert from "node:assert/strict";
import test from "node:test";
import { applyRemoteDelete, applyRemoteUpsert } from "../src/remote-change.ts";

test("远端 reminder tombstone 先取消系统通知再删除实体", async () => {
  const events: string[] = [];
  const handled = await applyRemoteDelete(
    {
      operation: "DELETE",
      entityType: "PERSONAL_REMINDER",
      entityId: "reminder-1",
    },
    {
      cancelReminder: async (id) => {
        events.push(`cancel:${id}`);
      },
      removeEntity: async (entityType, id) => {
        events.push(`remove:${entityType}:${id}`);
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(events, ["cancel:reminder-1", "remove:PERSONAL_REMINDER:reminder-1"]);
});

test("非提醒删除不触碰通知，UPSERT 不执行 tombstone 副作用", async () => {
  const events: string[] = [];
  const effects = {
    cancelReminder: async (id: string) => {
      events.push(`cancel:${id}`);
    },
    removeEntity: async (entityType: string, id: string) => {
      events.push(`remove:${entityType}:${id}`);
    },
  };

  assert.equal(
    await applyRemoteDelete(
      { operation: "DELETE", entityType: "PERSONAL_TASK", entityId: "task-1" },
      effects,
    ),
    true,
  );
  assert.equal(
    await applyRemoteDelete(
      { operation: "UPSERT", entityType: "PERSONAL_REMINDER", entityId: "reminder-2" },
      effects,
    ),
    false,
  );
  assert.deepEqual(events, ["remove:PERSONAL_TASK:task-1"]);
});

test("远端 reminder UPSERT 落库后立即重建通知，不依赖任务页挂载", async () => {
  const events: string[] = [];
  const reminder = {
    id: "reminder-2",
    title: "跨设备提醒",
    note: "已改期",
    scheduledAt: "2026-08-22T00:00:00.000Z",
    completedAt: null,
    notifiedAt: null,
    revision: 3,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
  };
  await applyRemoteUpsert("PERSONAL_REMINDER", reminder, {
    saveEntity: async (entity) => {
      events.push(`save:${entity.id}`);
    },
    scheduleReminder: async (entity) => {
      events.push(`schedule:${entity.id}`);
    },
  });
  assert.deepEqual(events, ["save:reminder-2", "schedule:reminder-2"]);
});

test("账号在远端提醒落库期间失效时不会再安排旧账号通知", async () => {
  let active = true;
  let releaseSave!: () => void;
  const saveBlocked = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const events: string[] = [];
  const applying = applyRemoteUpsert(
    "PERSONAL_REMINDER",
    {
      id: "reminder-stale",
      title: "旧账号提醒",
      note: "",
      scheduledAt: "2026-08-22T00:00:00.000Z",
      completedAt: null,
      notifiedAt: null,
      revision: 2,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:01:00.000Z",
    },
    {
      saveEntity: async () => {
        events.push("save:start");
        await saveBlocked;
        events.push("save:end");
      },
      scheduleReminder: async () => {
        events.push("schedule");
      },
      shouldContinue: () => active,
    },
  );
  active = false;
  releaseSave();
  await applying;
  assert.deepEqual(events, ["save:start", "save:end"]);
});

test("账号在系统调度期间失效时会撤销刚写入的旧账号通知", async () => {
  let active = true;
  let releaseSchedule!: () => void;
  const scheduleBlocked = new Promise<void>((resolve) => {
    releaseSchedule = resolve;
  });
  const events: string[] = [];
  const reminder = {
    id: "reminder-stale-scheduled",
    title: "旧账号提醒",
    note: "",
    scheduledAt: "2026-08-22T00:00:00.000Z",
    completedAt: null,
    notifiedAt: null,
    revision: 2,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:01:00.000Z",
  };
  const applying = applyRemoteUpsert("PERSONAL_REMINDER", reminder, {
    saveEntity: async () => {
      events.push("save");
    },
    scheduleReminder: async () => {
      events.push("schedule:start");
      await scheduleBlocked;
      events.push("schedule:end");
    },
    cancelReminder: async (id) => {
      events.push(`cancel:${id}`);
    },
    shouldContinue: () => active,
  });
  await Promise.resolve();
  active = false;
  releaseSchedule();
  await applying;
  assert.deepEqual(events, [
    "save",
    "schedule:start",
    "schedule:end",
    "cancel:reminder-stale-scheduled",
  ]);
});
