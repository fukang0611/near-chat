import assert from "node:assert/strict";
import test from "node:test";
import { parsePersonalSyncPayload } from "./personal-service.js";

test("个人同步 payload 只保留服务端允许写入的字段", () => {
  assert.deepEqual(
    parsePersonalSyncPayload("PERSONAL_TASK", {
      id: "00000000-0000-4000-8000-000000000001",
      title: "  离线任务  ",
      note: "说明",
      dueAt: null,
      completedAt: null,
      revision: 99,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      ownerId: "不应信任",
    }),
    { title: "离线任务", note: "说明", dueAt: null, completedAt: null },
  );
  assert.throws(
    () =>
      parsePersonalSyncPayload("PERSONAL_RECORD", {
        title: "记录",
        content: "",
      }),
    /个人记录内容不能为空/,
  );
});
