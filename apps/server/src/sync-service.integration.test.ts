import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperation } from "@near-chat/domain";
import pg from "pg";
import { deleteAiModelWithClient } from "./ai/ai-settings-service.js";
import { forgetMemoryWithClient } from "./memory-service.js";
import { databaseMigrations } from "./migrations.js";
import { lockOwnerSyncStream, recordSyncSnapshot } from "./sync-projection.js";
import {
  bootstrapSyncWithClient,
  projectBusinessEntityForSync,
  pullSyncChangesWithClient,
  pushSyncOperationsWithClient,
  registerSyncDeviceWithClient,
  resolveMemorySyncConflictWithClient,
} from "./sync-service.js";

const databaseUrl = process.env.SYNC_INTEGRATION_DATABASE_URL;

test(
  "owner stream 锁保证低序号提交后 cursor 才能推进到后续序号",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    const first = await pool.connect();
    const second = await pool.connect();
    const observer = await pool.connect();
    const ownerId = randomUUID();
    const firstEntityId = randomUUID();
    const secondEntityId = randomUUID();
    let firstOpen = false;
    let secondOpen = false;
    try {
      await observer.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'游标并发测试用户','test','USER','#6757E8')`,
        [ownerId, `cursor_${ownerId.replaceAll("-", "")}`],
      );
      await first.query("BEGIN");
      firstOpen = true;
      await second.query("BEGIN");
      secondOpen = true;

      await lockOwnerSyncStream(first, ownerId);
      await recordSyncSnapshot(first, ownerId, "PERSONAL_RECORD", firstEntityId, 1, {
        id: firstEntityId,
        title: "先分配的低序号",
        content: "尚未提交",
        revision: 1,
      });

      const contested = await second.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired`,
        [`near-chat:sync-stream:owner:${ownerId}`],
      );
      assert.equal(contested.rows[0]!.acquired, false);
      const beforeFirstCommit = await observer.query<{ sequence: string }>(
        `SELECT COALESCE(MAX(sequence),0)::text AS sequence
           FROM sync_changes WHERE owner_id=$1`,
        [ownerId],
      );
      assert.equal(beforeFirstCommit.rows[0]!.sequence, "0");

      await first.query("COMMIT");
      firstOpen = false;
      await lockOwnerSyncStream(second, ownerId);
      await recordSyncSnapshot(second, ownerId, "PERSONAL_RECORD", secondEntityId, 1, {
        id: secondEntityId,
        title: "后分配的高序号",
        content: "仍未提交",
        revision: 1,
      });

      const visibleLow = await observer.query<{ sequence: string; entity_id: string }>(
        `SELECT sequence::text,entity_id
           FROM sync_changes
          WHERE owner_id=$1
          ORDER BY sequence`,
        [ownerId],
      );
      assert.equal(visibleLow.rows.length, 1);
      assert.equal(visibleLow.rows[0]!.entity_id, firstEntityId);
      const cursor = visibleLow.rows[0]!.sequence;

      await second.query("COMMIT");
      secondOpen = false;
      const afterCursor = await observer.query<{ sequence: string; entity_id: string }>(
        `SELECT sequence::text,entity_id
           FROM sync_changes
          WHERE owner_id=$1 AND sequence>$2
          ORDER BY sequence`,
        [ownerId, cursor],
      );
      assert.equal(afterCursor.rows.length, 1);
      assert.equal(afterCursor.rows[0]!.entity_id, secondEntityId);
      assert.ok(BigInt(afterCursor.rows[0]!.sequence) > BigInt(cursor));
    } finally {
      if (firstOpen) await first.query("ROLLBACK");
      if (secondOpen) await second.query("ROLLBACK");
      await observer.query(`DELETE FROM users WHERE id=$1`, [ownerId]);
      first.release();
      second.release();
      observer.release();
      await pool.end();
    }
  },
);

test("七类同步实体写入真实业务表并支持幂等 ACK 与 tombstone", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 测试库的 v7 早于本索引补充执行；事务内补建并随 ROLLBACK 回收。
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_changes_entity_revision
         ON sync_changes(owner_id,entity_type,entity_id,revision)`,
    );
    const ownerId = randomUUID();
    await client.query(
      `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
         VALUES ($1,$2,'同步测试用户','test','USER','#6757E8')`,
      [ownerId, `sync_${ownerId.replaceAll("-", "")}`],
    );
    const device = await registerSyncDeviceWithClient(client, ownerId, {
      installationId: randomUUID(),
      name: "integration-device",
      platform: "TEST",
      appVersion: "1",
    });
    const taskId = randomUUID();
    const reminderId = randomUUID();
    const recordId = randomUUID();
    const memoryId = randomUUID();
    const assistantId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const now = "2026-08-21T00:00:00.000Z";
    const operation = (
      entityType: SyncOperation["entityType"],
      entityId: string,
      payload: Record<string, unknown>,
    ): SyncOperation => ({
      operationId: randomUUID(),
      entityType,
      entityId,
      operation: "UPSERT",
      baseRevision: null,
      payload,
      deviceCreatedAt: now,
    });
    const operations: SyncOperation[] = [
      operation("PERSONAL_TASK", taskId, {
        id: taskId,
        title: "任务",
        note: "",
        dueAt: null,
        completedAt: null,
        revision: 77,
      }),
      operation("PERSONAL_REMINDER", reminderId, {
        id: reminderId,
        title: "提醒",
        note: "",
        scheduledAt: "2026-08-22T00:00:00.000Z",
        completedAt: null,
        notifiedAt: null,
        revision: 77,
      }),
      operation("PERSONAL_RECORD", recordId, {
        id: recordId,
        title: "记录",
        content: "正文",
        revision: 77,
      }),
      operation("MEMORY", memoryId, {
        id: memoryId,
        tier: "LONG_TERM",
        scope: "PRIVATE",
        conversationId: null,
        kind: "NOTE",
        title: "记忆",
        content: "内容",
        importance: 3,
        status: "ACTIVE",
        revision: 77,
        expiresAt: null,
        // 同步入口不得相信设备提供的来源；服务端应生成自己的 MANUAL 来源。
        sources: [{ type: "MESSAGE", label: "伪造来源" }],
      }),
      operation("ASSISTANT", assistantId, {
        id: assistantId,
        name: "助理",
        description: "",
        category: "GENERAL",
        instructions: "只做测试",
        avatarColor: "#6757E8",
        modelId: null,
        revision: 77,
      }),
      operation("ASSISTANT_THREAD", threadId, {
        id: threadId,
        assistantId,
        title: "默认对话",
        archived: false,
        isDefault: true,
        revision: 77,
      }),
      operation("ASSISTANT_MESSAGE", messageId, {
        id: messageId,
        assistantId,
        threadId,
        role: "USER",
        content: "你好",
        modelId: null,
        sources: [],
        revision: 77,
      }),
    ];

    const first = await pushSyncOperationsWithClient(client, ownerId, device.id, operations);
    assert.equal(first.conflicts.length, 0);
    assert.deepEqual(
      first.acknowledgedOperationIds,
      operations.map((item) => item.operationId),
    );
    assert.equal(first.applied.length, 7);
    assert.equal(
      first.applied.every((item) => item.sequence !== "0"),
      true,
    );
    const reusedAgainstExisting: SyncOperation = {
      ...operations[0]!,
      payload: { ...operations[0]!.payload, title: "复用了旧 operationId" },
    };
    const reusedExistingResult = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      reusedAgainstExisting,
    ]);
    assert.equal(reusedExistingResult.conflicts[0]?.reason, "OPERATION_ID_REUSED");
    assert.equal(reusedExistingResult.conflicts[0]?.serverRevision, 1);
    assert.equal(reusedExistingResult.conflicts[0]?.serverPayload.title, "任务");
    await client.query("SAVEPOINT assert_unique_change");
    await assert.rejects(
      client.query(
        `INSERT INTO sync_changes
           (owner_id,entity_type,entity_id,operation,revision,payload)
         VALUES ($1,'PERSONAL_TASK',$2,'UPSERT',1,'{}'::jsonb)`,
        [ownerId, taskId],
      ),
      (error: unknown) =>
        Boolean(error && typeof error === "object" && "code" in error && error.code === "23505"),
    );
    await client.query("ROLLBACK TO SAVEPOINT assert_unique_change");
    await client.query("RELEASE SAVEPOINT assert_unique_change");

    const tableChecks = [];
    tableChecks.push(
      await client.query(`SELECT revision FROM personal_tasks WHERE id=$1 AND owner_id=$2`, [
        taskId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision FROM personal_reminders WHERE id=$1 AND owner_id=$2`, [
        reminderId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision FROM personal_records WHERE id=$1 AND owner_id=$2`, [
        recordId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision FROM memories WHERE id=$1 AND owner_id=$2`, [
        memoryId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision FROM ai_assistants WHERE id=$1 AND owner_id=$2`, [
        assistantId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision FROM ai_assistant_threads WHERE id=$1 AND owner_id=$2`, [
        threadId,
        ownerId,
      ]),
    );
    tableChecks.push(
      await client.query(`SELECT revision,sources FROM ai_assistant_messages WHERE id=$1`, [
        messageId,
      ]),
    );
    assert.deepEqual(
      tableChecks.map((result) => result.rows[0]?.revision),
      [1, 1, 1, 1, 3, 2, 1],
    );
    assert.deepEqual(tableChecks[6]!.rows[0]!.sources, []);
    const initialMemorySources = await client.query<{
      source_type: string;
      source_id: string | null;
      conversation_id: string | null;
      label: string;
    }>(
      `SELECT source_type,source_id,conversation_id,label
         FROM memory_sources
        WHERE memory_id=$1
        ORDER BY created_at,id`,
      [memoryId],
    );
    assert.deepEqual(initialMemorySources.rows, [
      {
        source_type: "MANUAL",
        source_id: null,
        conversation_id: null,
        label: "移动端手动创建",
      },
    ]);

    const shortMemoryId = randomUUID();
    const shortMemoryCreate = operation("MEMORY", shortMemoryId, {
      id: shortMemoryId,
      tier: "SHORT_TERM",
      scope: "PRIVATE",
      conversationId: null,
      kind: "NOTE",
      title: "短期记忆",
      content: "由服务端确定七天到期时间",
      importance: 3,
      status: "ACTIVE",
      revision: 77,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const shortMemoryCreatedAt = Date.now();
    const shortMemoryCreated = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      shortMemoryCreate,
    ]);
    assert.deepEqual(shortMemoryCreated.acknowledgedOperationIds, [shortMemoryCreate.operationId]);
    const initialShortMemory = (
      await client.query<{ expires_at: Date; revision: number }>(
        `SELECT expires_at,revision FROM memories WHERE id=$1 AND owner_id=$2`,
        [shortMemoryId, ownerId],
      )
    ).rows[0]!;
    assert.equal(initialShortMemory.revision, 1);
    assert.ok(initialShortMemory.expires_at.getTime() >= shortMemoryCreatedAt + 6.9 * 86_400_000);
    assert.ok(initialShortMemory.expires_at.getTime() <= Date.now() + 7.1 * 86_400_000);

    const shortMemoryUpdate: SyncOperation = {
      ...shortMemoryCreate,
      operationId: randomUUID(),
      baseRevision: 1,
      payload: {
        ...shortMemoryCreate.payload,
        content: "编辑短期记忆不延长原到期时间",
        expiresAt: "2098-01-01T00:00:00.000Z",
      },
    };
    const shortMemoryUpdated = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      shortMemoryUpdate,
    ]);
    assert.deepEqual(shortMemoryUpdated.acknowledgedOperationIds, [shortMemoryUpdate.operationId]);
    const updatedShortMemory = (
      await client.query<{ expires_at: Date; revision: number }>(
        `SELECT expires_at,revision FROM memories WHERE id=$1 AND owner_id=$2`,
        [shortMemoryId, ownerId],
      )
    ).rows[0]!;
    assert.equal(updatedShortMemory.revision, 2);
    assert.equal(updatedShortMemory.expires_at.getTime(), initialShortMemory.expires_at.getTime());

    const shortMemoryToLong: SyncOperation = {
      ...shortMemoryUpdate,
      operationId: randomUUID(),
      baseRevision: 2,
      payload: { ...shortMemoryUpdate.payload, tier: "LONG_TERM" },
    };
    await pushSyncOperationsWithClient(client, ownerId, device.id, [shortMemoryToLong]);
    const longMemory = (
      await client.query<{ expires_at: Date | null; revision: number }>(
        `SELECT expires_at,revision FROM memories WHERE id=$1 AND owner_id=$2`,
        [shortMemoryId, ownerId],
      )
    ).rows[0]!;
    assert.equal(longMemory.revision, 3);
    assert.equal(longMemory.expires_at, null);

    const shortMemoryRestartedAt = Date.now();
    const longMemoryToShort: SyncOperation = {
      ...shortMemoryToLong,
      operationId: randomUUID(),
      baseRevision: 3,
      payload: { ...shortMemoryToLong.payload, tier: "SHORT_TERM" },
    };
    await pushSyncOperationsWithClient(client, ownerId, device.id, [longMemoryToShort]);
    const restartedShortMemory = (
      await client.query<{ expires_at: Date; revision: number }>(
        `SELECT expires_at,revision FROM memories WHERE id=$1 AND owner_id=$2`,
        [shortMemoryId, ownerId],
      )
    ).rows[0]!;
    assert.equal(restartedShortMemory.revision, 4);
    assert.ok(
      restartedShortMemory.expires_at.getTime() >= shortMemoryRestartedAt + 6.9 * 86_400_000,
    );
    assert.ok(restartedShortMemory.expires_at.getTime() <= Date.now() + 7.1 * 86_400_000);

    const duplicateMessage: SyncOperation = {
      ...operations[6]!,
      operationId: randomUUID(),
    };
    const duplicateMessageResult = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      duplicateMessage,
    ]);
    assert.deepEqual(duplicateMessageResult.acknowledgedOperationIds, [
      duplicateMessage.operationId,
    ]);
    assert.equal(duplicateMessageResult.conflicts.length, 0);
    assert.notEqual(duplicateMessageResult.applied[0]?.sequence, "0");

    const changeCount = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM sync_changes WHERE owner_id=$1`,
      [ownerId],
    );
    const retried = await pushSyncOperationsWithClient(client, ownerId, device.id, operations);
    assert.deepEqual(
      retried.acknowledgedOperationIds,
      operations.map((item) => item.operationId),
    );
    const afterRetry = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM sync_changes WHERE owner_id=$1`,
      [ownerId],
    );
    assert.equal(afterRetry.rows[0]!.total, changeCount.rows[0]!.total);

    const serverMemoryUpdate: SyncOperation = {
      ...operations[3]!,
      operationId: randomUUID(),
      baseRevision: 1,
      payload: { ...operations[3]!.payload, content: "服务端新内容" },
    };
    const updatedMemory = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      serverMemoryUpdate,
    ]);
    assert.deepEqual(updatedMemory.acknowledgedOperationIds, [serverMemoryUpdate.operationId]);
    const sourcesAfterMemoryUpdate = await client.query<{ source_type: string; label: string }>(
      `SELECT source_type,label FROM memory_sources WHERE memory_id=$1 ORDER BY created_at,id`,
      [memoryId],
    );
    assert.deepEqual(sourcesAfterMemoryUpdate.rows, [
      { source_type: "MANUAL", label: "移动端手动创建" },
    ]);

    const dismissedConflictOperation: SyncOperation = {
      ...serverMemoryUpdate,
      operationId: randomUUID(),
      payload: { ...serverMemoryUpdate.payload, content: "旧设备内容" },
    };
    const dismissedConflict = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      dismissedConflictOperation,
    ]);
    assert.equal(dismissedConflict.conflicts[0]?.reason, "MEMORY_MERGE_REQUIRED");
    const resolvedConflictOperation: SyncOperation = {
      ...serverMemoryUpdate,
      operationId: randomUUID(),
      payload: { ...serverMemoryUpdate.payload, content: "合并前的本地内容" },
    };
    const resolvedConflict = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      resolvedConflictOperation,
    ]);
    assert.equal(resolvedConflict.conflicts[0]?.reason, "MEMORY_MERGE_REQUIRED");
    const mergedMemory: SyncOperation = {
      ...serverMemoryUpdate,
      operationId: randomUUID(),
      baseRevision: 2,
      payload: { ...serverMemoryUpdate.payload, content: "用户确认后的合并内容" },
    };
    const merged = await pushSyncOperationsWithClient(client, ownerId, device.id, [mergedMemory]);
    assert.deepEqual(merged.acknowledgedOperationIds, [mergedMemory.operationId]);
    // 另一设备的成功写入不能代替本设备作冲突选择；两个原冲突都仍待显式处理。
    const stillPending = await client.query<{ operation_id: string; status: string }>(
      `SELECT operation_id,status FROM memory_sync_conflicts
        WHERE owner_id=$1 AND operation_id=ANY($2::uuid[])`,
      [ownerId, [dismissedConflictOperation.operationId, resolvedConflictOperation.operationId]],
    );
    assert.equal(
      stillPending.rows.every((row) => row.status === "PENDING"),
      true,
    );
    const dismissed = await resolveMemorySyncConflictWithClient(
      client,
      ownerId,
      dismissedConflictOperation.operationId,
      "DISMISSED",
    );
    assert.equal(dismissed.status, "DISMISSED");
    assert.deepEqual(
      await resolveMemorySyncConflictWithClient(
        client,
        ownerId,
        dismissedConflictOperation.operationId,
        "DISMISSED",
      ),
      dismissed,
    );
    const resolved = await resolveMemorySyncConflictWithClient(
      client,
      ownerId,
      resolvedConflictOperation.operationId,
      "RESOLVED",
    );
    assert.equal(resolved.status, "RESOLVED");
    assert.deepEqual(
      await resolveMemorySyncConflictWithClient(
        client,
        ownerId,
        resolvedConflictOperation.operationId,
        "RESOLVED",
      ),
      resolved,
    );
    const conflictStatuses = await client.query<{ operation_id: string; status: string }>(
      `SELECT operation_id,status FROM memory_sync_conflicts
          WHERE owner_id=$1 AND operation_id=ANY($2::uuid[])
          ORDER BY operation_id`,
      [ownerId, [dismissedConflictOperation.operationId, resolvedConflictOperation.operationId]],
    );
    assert.deepEqual(
      new Map(conflictStatuses.rows.map((row) => [row.operation_id, row.status])),
      new Map([
        [dismissedConflictOperation.operationId, "DISMISSED"],
        [resolvedConflictOperation.operationId, "RESOLVED"],
      ]),
    );

    const deleteMemory: SyncOperation = {
      operationId: randomUUID(),
      entityType: "MEMORY",
      entityId: memoryId,
      operation: "DELETE",
      baseRevision: 3,
      payload: {},
      deviceCreatedAt: now,
    };
    const deletedMemory = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      deleteMemory,
    ]);
    assert.deepEqual(deletedMemory.acknowledgedOperationIds, [deleteMemory.operationId]);
    assert.equal(deletedMemory.applied[0]?.operation, "DELETE");
    const memoryTombstone = deletedMemory.applied[0]!.payload;
    assert.deepEqual(Object.keys(memoryTombstone).sort(), ["deletedAt", "id", "revision"]);
    assert.equal(memoryTombstone.id, memoryId);
    assert.equal(memoryTombstone.revision, 4);
    assert.equal(typeof memoryTombstone.deletedAt, "string");
    const storedMemoryTombstones = await client.query<{
      snapshot_payload: Record<string, unknown>;
      change_payload: Record<string, unknown>;
      outcome_payload: Record<string, unknown>;
    }>(
      `SELECT
         (SELECT payload
            FROM sync_entity_snapshots
           WHERE owner_id=$1 AND entity_type='MEMORY' AND entity_id=$2) AS snapshot_payload,
         (SELECT payload
            FROM sync_changes
           WHERE owner_id=$1 AND entity_type='MEMORY' AND entity_id=$2
             AND operation='DELETE' AND revision=$3
           ORDER BY sequence DESC LIMIT 1) AS change_payload,
         (SELECT outcome #> '{applied,payload}'
            FROM sync_operations
           WHERE owner_id=$1 AND operation_id=$4) AS outcome_payload`,
      [ownerId, memoryId, 4, deleteMemory.operationId],
    );
    assert.deepEqual(storedMemoryTombstones.rows[0]!.snapshot_payload, memoryTombstone);
    assert.deepEqual(storedMemoryTombstones.rows[0]!.change_payload, memoryTombstone);
    assert.deepEqual(storedMemoryTombstones.rows[0]!.outcome_payload, memoryTombstone);
    const preservedMemorySources = await client.query<{ source_type: string; label: string }>(
      `SELECT source_type,label FROM memory_sources WHERE memory_id=$1 ORDER BY created_at,id`,
      [memoryId],
    );
    assert.deepEqual(preservedMemorySources.rows, [
      { source_type: "MANUAL", label: "移动端手动创建" },
    ]);

    const currentOnlyThreadRevision = (
      await client.query<{ revision: number }>(
        `SELECT revision FROM ai_assistant_threads WHERE id=$1`,
        [threadId],
      )
    ).rows[0]!.revision;
    const rejectedOnlyThreadDelete: SyncOperation = {
      operationId: randomUUID(),
      entityType: "ASSISTANT_THREAD",
      entityId: threadId,
      operation: "DELETE",
      baseRevision: currentOnlyThreadRevision,
      payload: {},
      deviceCreatedAt: now,
    };
    const batchRecordId = randomUUID();
    const validBatchRecord = operation("PERSONAL_RECORD", batchRecordId, {
      title: "批处理继续执行",
      content: "前一项失败也不能回滚本项",
    });
    const mixedBatch = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      rejectedOnlyThreadDelete,
      validBatchRecord,
    ]);
    assert.equal(mixedBatch.conflicts[0]?.operationId, rejectedOnlyThreadDelete.operationId);
    assert.deepEqual(mixedBatch.acknowledgedOperationIds, [validBatchRecord.operationId]);
    assert.equal(
      (
        await client.query(`SELECT 1 FROM personal_records WHERE id=$1 AND owner_id=$2`, [
          batchRecordId,
          ownerId,
        ])
      ).rowCount,
      1,
    );

    const secondThreadId = randomUUID();
    const createSecondThread = operation("ASSISTANT_THREAD", secondThreadId, {
      assistantId,
      title: "后续对话",
      archived: false,
      isDefault: false,
    });
    const secondThreadCreated = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      createSecondThread,
    ]);
    assert.deepEqual(secondThreadCreated.acknowledgedOperationIds, [
      createSecondThread.operationId,
    ]);

    const threadTaskId = randomUUID();
    const threadReminderId = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_tasks
           (id,assistant_id,thread_id,owner_id,title,prompt,schedule_type)
         VALUES ($1,$2,$3,$4,'级联任务','测试','ONCE')`,
      [threadTaskId, assistantId, threadId, ownerId],
    );
    await client.query(
      `INSERT INTO ai_assistant_reminders
           (id,assistant_id,thread_id,owner_id,title,scheduled_at)
         VALUES ($1,$2,$3,$4,'级联提醒',NOW())`,
      [threadReminderId, assistantId, threadId, ownerId],
    );
    const threadRevision = (
      await client.query<{ revision: number }>(
        `SELECT revision FROM ai_assistant_threads WHERE id=$1`,
        [threadId],
      )
    ).rows[0]!.revision;
    const deleteThread: SyncOperation = {
      operationId: randomUUID(),
      entityType: "ASSISTANT_THREAD",
      entityId: threadId,
      operation: "DELETE",
      baseRevision: threadRevision,
      payload: {},
      deviceCreatedAt: now,
    };
    const deletedThread = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      deleteThread,
    ]);
    assert.deepEqual(deletedThread.acknowledgedOperationIds, [deleteThread.operationId]);
    assert.notEqual(deletedThread.applied[0]?.sequence, "0");
    for (const [table, id] of [
      ["ai_assistant_threads", threadId],
      ["ai_assistant_messages", messageId],
      ["ai_assistant_tasks", threadTaskId],
      ["ai_assistant_reminders", threadReminderId],
    ] as const) {
      const remaining = await client.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
      assert.equal(remaining.rowCount, 0, `${table} 应被硬删除`);
    }
    const threadTombstones = await client.query<{ entity_id: string; deleted_at: Date | null }>(
      `SELECT entity_id,deleted_at FROM sync_entity_snapshots
          WHERE owner_id=$1 AND entity_type IN ('ASSISTANT_THREAD','ASSISTANT_MESSAGE')
            AND entity_id=ANY($2::uuid[])`,
      [ownerId, [threadId, messageId]],
    );
    assert.equal(threadTombstones.rows.length, 2);
    assert.equal(
      threadTombstones.rows.every((row) => Boolean(row.deleted_at)),
      true,
    );
    assert.equal(
      (
        await client.query<{ is_default: boolean }>(
          `SELECT is_default FROM ai_assistant_threads WHERE id=$1`,
          [secondThreadId],
        )
      ).rows[0]!.is_default,
      true,
    );

    const disposableMessageId = randomUUID();
    const createDisposableMessage = operation("ASSISTANT_MESSAGE", disposableMessageId, {
      assistantId,
      threadId: secondThreadId,
      role: "USER",
      content: "即将删除",
      modelId: null,
      sources: [],
    });
    await pushSyncOperationsWithClient(client, ownerId, device.id, [createDisposableMessage]);
    const deleteMessage: SyncOperation = {
      operationId: randomUUID(),
      entityType: "ASSISTANT_MESSAGE",
      entityId: disposableMessageId,
      operation: "DELETE",
      baseRevision: 1,
      payload: {},
      deviceCreatedAt: now,
    };
    const deletedMessage = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      deleteMessage,
    ]);
    assert.deepEqual(deletedMessage.acknowledgedOperationIds, [deleteMessage.operationId]);
    assert.equal(
      (await client.query(`SELECT 1 FROM ai_assistant_messages WHERE id=$1`, [disposableMessageId]))
        .rowCount,
      0,
    );
    assert.equal(
      Boolean(
        (
          await client.query<{ deleted_at: Date | null }>(
            `SELECT deleted_at FROM sync_entity_snapshots
                WHERE owner_id=$1 AND entity_type='ASSISTANT_MESSAGE' AND entity_id=$2`,
            [ownerId, disposableMessageId],
          )
        ).rows[0]!.deleted_at,
      ),
      true,
    );

    const finalMessageId = randomUUID();
    await pushSyncOperationsWithClient(client, ownerId, device.id, [
      operation("ASSISTANT_MESSAGE", finalMessageId, {
        assistantId,
        threadId: secondThreadId,
        role: "USER",
        content: "随助理删除",
        modelId: null,
        sources: [],
      }),
    ]);
    const assistantTaskId = randomUUID();
    const assistantReminderId = randomUUID();
    const browserRunId = randomUUID();
    const attachmentId = randomUUID();
    const assistantFileId = randomUUID();
    const connectorId = randomUUID();
    const connectorBindingId = randomUUID();
    await client.query(
      `INSERT INTO ai_assistant_tasks
           (id,assistant_id,thread_id,owner_id,title,prompt,schedule_type)
         VALUES ($1,$2,$3,$4,'助理级联任务','测试','ONCE')`,
      [assistantTaskId, assistantId, secondThreadId, ownerId],
    );
    await client.query(
      `INSERT INTO ai_assistant_reminders
           (id,assistant_id,thread_id,owner_id,title,scheduled_at)
         VALUES ($1,$2,$3,$4,'助理级联提醒',NOW())`,
      [assistantReminderId, assistantId, secondThreadId, ownerId],
    );
    await client.query(
      `INSERT INTO ai_assistant_browser_runs
           (id,assistant_id,owner_id,goal,start_url)
         VALUES ($1,$2,$3,'测试级联','https://example.com')`,
      [browserRunId, assistantId, ownerId],
    );
    await client.query(
      `INSERT INTO attachments
           (id,uploader_id,bucket_name,object_key,original_name,content_type,size_bytes)
         VALUES ($1,$2,'test',$3,'test.txt','text/plain',1)`,
      [attachmentId, ownerId, `sync-test/${attachmentId}`],
    );
    await client.query(
      `INSERT INTO ai_assistant_files
           (id,assistant_id,owner_id,attachment_id,origin)
         VALUES ($1,$2,$3,$4,'UPLOAD')`,
      [assistantFileId, assistantId, ownerId, attachmentId],
    );
    await client.query(
      `INSERT INTO connector_configs
           (id,provider,name,config_encrypted,created_by)
         VALUES ($1,'WECOM_WEBHOOK','sync-test','test',$2)`,
      [connectorId, ownerId],
    );
    await client.query(
      `INSERT INTO connector_bindings
           (id,connector_id,owner_id,external_conversation_id,assistant_id)
         VALUES ($1,$2,$3,$4,$5)`,
      [connectorBindingId, connectorId, ownerId, randomUUID(), assistantId],
    );
    const assistantRevision = (
      await client.query<{ revision: number }>(`SELECT revision FROM ai_assistants WHERE id=$1`, [
        assistantId,
      ])
    ).rows[0]!.revision;
    const deleteAssistant: SyncOperation = {
      operationId: randomUUID(),
      entityType: "ASSISTANT",
      entityId: assistantId,
      operation: "DELETE",
      baseRevision: assistantRevision,
      payload: {},
      deviceCreatedAt: now,
    };
    const deletedAssistant = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      deleteAssistant,
    ]);
    assert.deepEqual(deletedAssistant.acknowledgedOperationIds, [deleteAssistant.operationId]);
    assert.notEqual(deletedAssistant.applied[0]?.sequence, "0");
    for (const [table, id] of [
      ["ai_assistants", assistantId],
      ["ai_assistant_threads", secondThreadId],
      ["ai_assistant_messages", finalMessageId],
      ["ai_assistant_tasks", assistantTaskId],
      ["ai_assistant_reminders", assistantReminderId],
      ["ai_assistant_browser_runs", browserRunId],
      ["ai_assistant_files", assistantFileId],
    ] as const) {
      const remaining = await client.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
      assert.equal(remaining.rowCount, 0, `${table} 应随助理硬删除`);
    }
    assert.equal(
      (
        await client.query<{ assistant_id: string | null }>(
          `SELECT assistant_id FROM connector_bindings WHERE id=$1`,
          [connectorBindingId],
        )
      ).rows[0]!.assistant_id,
      null,
    );
    assert.equal(
      (
        await client.query<{ state: string }>(`SELECT state FROM attachments WHERE id=$1`, [
          attachmentId,
        ])
      ).rows[0]!.state,
      "CLEANUP_FAILED",
    );
    const assistantTombstones = await client.query<{ entity_id: string; deleted_at: Date | null }>(
      `SELECT entity_id,deleted_at FROM sync_entity_snapshots
          WHERE owner_id=$1 AND entity_id=ANY($2::uuid[])`,
      [ownerId, [assistantId, secondThreadId, finalMessageId]],
    );
    assert.equal(assistantTombstones.rows.length, 3);
    assert.equal(
      assistantTombstones.rows.every((row) => Boolean(row.deleted_at)),
      true,
    );

    const deleteRecord: SyncOperation = {
      operationId: randomUUID(),
      entityType: "PERSONAL_RECORD",
      entityId: recordId,
      operation: "DELETE",
      baseRevision: 1,
      payload: {},
      deviceCreatedAt: now,
    };
    const deleted = await pushSyncOperationsWithClient(client, ownerId, device.id, [deleteRecord]);
    assert.deepEqual(deleted.acknowledgedOperationIds, [deleteRecord.operationId]);
    assert.equal(deleted.applied[0]?.operation, "DELETE");
    assert.equal(
      Boolean(
        (await client.query(`SELECT deleted_at FROM personal_records WHERE id=$1`, [recordId]))
          .rows[0]?.deleted_at,
      ),
      true,
    );
    const reusedAgainstTombstone: SyncOperation = {
      ...deleteRecord,
      operation: "UPSERT",
      baseRevision: null,
      payload: { title: "不应覆盖 tombstone", content: "本机旧内容" },
    };
    const reusedDeletedResult = await pushSyncOperationsWithClient(client, ownerId, device.id, [
      reusedAgainstTombstone,
    ]);
    assert.equal(reusedDeletedResult.conflicts[0]?.reason, "OPERATION_ID_REUSED");
    assert.equal(reusedDeletedResult.conflicts[0]?.serverRevision, 2);
    assert.equal(typeof reusedDeletedResult.conflicts[0]?.serverPayload.deletedAt, "string");

    const bootstrap = await bootstrapSyncWithClient(client, ownerId, device.id);
    assert.equal(bootstrap.changes.length >= 7, true);
    assert.equal(
      bootstrap.changes.some((item) => item.entityId === recordId),
      true,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("删除模型时 FK 置空会同步推进助理和消息 revision", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ownerId = randomUUID();
    const modelId = randomUUID();
    const assistantId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    await client.query(
      `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
       VALUES ($1,$2,'模型删除同步测试','test','ADMIN','#6757E8')`,
      [ownerId, `model_delete_${ownerId.replaceAll("-", "")}`],
    );
    await client.query(
      `INSERT INTO ai_model_configs
           (id,name,base_url,provider_model,enabled,created_by,updated_by)
       VALUES ($1,$2,'https://model.example/v1','test-model',TRUE,$3,$3)`,
      [modelId, `model_${modelId}`, ownerId],
    );
    await client.query(
      `INSERT INTO ai_settings (id,enabled,default_chat_model_id,updated_by)
       VALUES (1,FALSE,NULL,$1)
       ON CONFLICT (id) DO UPDATE
         SET enabled=FALSE,default_chat_model_id=NULL,updated_by=EXCLUDED.updated_by`,
      [ownerId],
    );
    await client.query(
      `INSERT INTO ai_assistants
           (id,owner_id,name,instructions,model_id)
       VALUES ($1,$2,'模型助理','测试',$3)`,
      [assistantId, ownerId, modelId],
    );
    await client.query(
      `INSERT INTO ai_assistant_threads
           (id,assistant_id,owner_id,title,is_default)
       VALUES ($1,$2,$3,'默认对话',TRUE)`,
      [threadId, assistantId, ownerId],
    );
    await client.query(
      `INSERT INTO ai_assistant_messages
           (id,assistant_id,thread_id,role,content,model_id)
       VALUES ($1,$2,$3,'ASSISTANT','测试回复',$4)`,
      [messageId, assistantId, threadId, modelId],
    );
    await projectBusinessEntityForSync(client, ownerId, "ASSISTANT", assistantId);
    await projectBusinessEntityForSync(client, ownerId, "ASSISTANT_MESSAGE", messageId);

    await deleteAiModelWithClient(client, ownerId, modelId);

    const assistant = await client.query<{ model_id: string | null; revision: number }>(
      `SELECT model_id,revision FROM ai_assistants WHERE id=$1`,
      [assistantId],
    );
    const message = await client.query<{ model_id: string | null; revision: number }>(
      `SELECT model_id,revision FROM ai_assistant_messages WHERE id=$1`,
      [messageId],
    );
    assert.deepEqual(assistant.rows[0], { model_id: null, revision: 2 });
    assert.deepEqual(message.rows[0], { model_id: null, revision: 2 });
    const changes = await client.query<{
      entity_type: string;
      entity_id: string;
      revision: number;
      payload: Record<string, unknown>;
    }>(
      `SELECT entity_type,entity_id,revision,payload
         FROM sync_changes
        WHERE owner_id=$1 AND entity_id=ANY($2::uuid[]) AND revision=2
        ORDER BY entity_type`,
      [ownerId, [assistantId, messageId]],
    );
    assert.equal(changes.rows.length, 2);
    assert.equal(
      changes.rows.every((row) => row.payload.modelId === null),
      true,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test(
  "bootstrap 不下发会话记忆并把历史泄漏快照收敛为 tombstone",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ownerId = randomUUID();
      const conversationId = randomUUID();
      const memoryId = randomUUID();
      await client.query(
        `INSERT INTO users
           (id,username,display_name,password_hash,role,avatar_color)
       VALUES ($1,$2,'会话记忆同步测试','test','USER','#6757E8')`,
        [ownerId, `conv_memory_${ownerId.replaceAll("-", "")}`],
      );
      await client.query(
        `INSERT INTO conversations (id,type,name,created_by,owner_id)
       VALUES ($1,'GROUP','同步边界测试',$2,$2)`,
        [conversationId, ownerId],
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2)`,
        [conversationId, ownerId],
      );
      await client.query(
        `INSERT INTO memories
           (id,owner_id,tier,scope,conversation_id,kind,title,content,importance,status)
       VALUES ($1,$2,'LONG_TERM','CONVERSATION',$3,'NOTE','团队秘密','不可进入手机离线库',3,'ACTIVE')`,
        [memoryId, ownerId, conversationId],
      );
      await recordSyncSnapshot(
        client,
        ownerId,
        "MEMORY",
        memoryId,
        1,
        {
          id: memoryId,
          scope: "CONVERSATION",
          conversationId,
          title: "团队秘密",
          content: "不可进入手机离线库",
          revision: 1,
        },
        false,
      );
      const device = await registerSyncDeviceWithClient(client, ownerId, {
        installationId: randomUUID(),
        name: "privacy-boundary-device",
        platform: "TEST",
        appVersion: "1",
      });

      const bootstrap = await bootstrapSyncWithClient(client, ownerId, device.id);
      const change = bootstrap.changes.find((candidate) => candidate.entityId === memoryId);
      assert.equal(change?.operation, "DELETE");
      assert.equal(change?.revision, 2);
      assert.equal(Object.hasOwn(change?.payload ?? {}, "content"), false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);

test(
  "v9 清洗历史 MEMORY DELETE 的 snapshot、change 和幂等 outcome 正文",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ownerId = randomUUID();
      const entityId = randomUUID();
      const operationId = randomUUID();
      const deletedAt = "2026-08-21T01:02:03.000Z";
      const leakedPayload = {
        id: entityId,
        tier: "LONG_TERM",
        scope: "PRIVATE",
        title: "历史敏感标题",
        content: "历史敏感正文",
        revision: 2,
        deletedAt,
      };
      await client.query(
        `INSERT INTO users
         (id,username,display_name,password_hash,role,avatar_color)
       VALUES ($1,$2,'迁移清洗测试用户','test','USER','#6757E8')`,
        [ownerId, `migration_${ownerId.replaceAll("-", "")}`],
      );
      const device = await registerSyncDeviceWithClient(client, ownerId, {
        installationId: randomUUID(),
        name: "migration-test-device",
        platform: "TEST",
        appVersion: "1",
      });
      await client.query(
        `INSERT INTO sync_entity_snapshots
         (owner_id,entity_type,entity_id,revision,payload,deleted_at)
       VALUES ($1,'MEMORY',$2,2,$3,$4)`,
        [ownerId, entityId, leakedPayload, deletedAt],
      );
      const change = await client.query<{ sequence: string }>(
        `INSERT INTO sync_changes
         (owner_id,entity_type,entity_id,operation,revision,payload,occurred_at)
       VALUES ($1,'MEMORY',$2,'DELETE',2,$3,$4)
       RETURNING sequence::text`,
        [ownerId, entityId, leakedPayload, deletedAt],
      );
      await client.query(
        `INSERT INTO sync_operations
         (operation_id,device_id,owner_id,entity_type,entity_id,operation,base_revision,
          request_fingerprint,outcome,device_created_at)
       VALUES ($1,$2,$3,'MEMORY',$4,'DELETE',1,$5,$6,$7)`,
        [
          operationId,
          device.id,
          ownerId,
          entityId,
          "0".repeat(64),
          {
            applied: {
              operationId,
              sequence: change.rows[0]!.sequence,
              entityType: "MEMORY",
              entityId,
              operation: "DELETE",
              revision: 2,
              payload: leakedPayload,
              occurredAt: deletedAt,
            },
          },
          deletedAt,
        ],
      );

      await databaseMigrations.find((item) => item.version === 9)!.up(client);

      const cleaned = await client.query<{
        snapshot_payload: Record<string, unknown>;
        change_payload: Record<string, unknown>;
        outcome: Record<string, unknown>;
      }>(
        `SELECT
         (SELECT payload FROM sync_entity_snapshots
           WHERE owner_id=$1 AND entity_type='MEMORY' AND entity_id=$2) AS snapshot_payload,
         (SELECT payload FROM sync_changes
           WHERE owner_id=$1 AND entity_type='MEMORY' AND entity_id=$2 AND operation='DELETE'
           ORDER BY sequence DESC LIMIT 1) AS change_payload,
         (SELECT outcome FROM sync_operations
           WHERE owner_id=$1 AND operation_id=$3) AS outcome`,
        [ownerId, entityId, operationId],
      );
      const expected = { id: entityId, revision: 2, deletedAt };
      assert.deepEqual(cleaned.rows[0]!.snapshot_payload, expected);
      assert.deepEqual(cleaned.rows[0]!.change_payload, expected);
      const applied = cleaned.rows[0]!.outcome.applied as Record<string, unknown>;
      assert.equal(applied.operationId, operationId);
      assert.deepEqual(applied.payload, expected);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);

test(
  "REST forget 服务仅投影最小 MEMORY tombstone 并保留服务端审计",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_changes_entity_revision
         ON sync_changes(owner_id,entity_type,entity_id,revision)`,
      );
      const ownerId = randomUUID();
      const memoryId = randomUUID();
      await client.query(
        `INSERT INTO users
         (id,username,display_name,password_hash,role,avatar_color)
       VALUES ($1,$2,'REST 遗忘测试用户','test','USER','#6757E8')`,
        [ownerId, `rest_forget_${ownerId.replaceAll("-", "")}`],
      );
      await client.query(
        `INSERT INTO memories
         (id,owner_id,tier,scope,kind,title,content,importance,status,revision)
       VALUES ($1,$2,'LONG_TERM','PRIVATE','NOTE','敏感标题','敏感正文',4,'ACTIVE',1)`,
        [memoryId, ownerId],
      );
      await client.query(
        `INSERT INTO memory_sources
         (id,memory_id,source_type,label)
       VALUES ($1,$2,'MANUAL','网页端手动创建')`,
        [randomUUID(), memoryId],
      );
      await client.query(
        `INSERT INTO memory_revisions
         (id,memory_id,revision,kind,title,content,importance,change_type,changed_by)
       VALUES ($1,$2,1,'NOTE','敏感标题','敏感正文',4,'CREATE',$3)`,
        [randomUUID(), memoryId, ownerId],
      );

      await forgetMemoryWithClient(client, ownerId, memoryId, 1);

      const persisted = await client.query<{
        status: string;
        revision: number;
        snapshot_payload: Record<string, unknown>;
        change_payload: Record<string, unknown>;
      }>(
        `SELECT memory.status,memory.revision,
         snapshot.payload AS snapshot_payload,
         change.payload AS change_payload
       FROM memories memory
       JOIN sync_entity_snapshots snapshot
         ON snapshot.owner_id=memory.owner_id AND snapshot.entity_type='MEMORY'
        AND snapshot.entity_id=memory.id
       JOIN sync_changes change
         ON change.owner_id=memory.owner_id AND change.entity_type='MEMORY'
        AND change.entity_id=memory.id AND change.operation='DELETE'
       WHERE memory.id=$1 AND memory.owner_id=$2`,
        [memoryId, ownerId],
      );
      assert.equal(persisted.rows[0]!.status, "DELETED");
      assert.equal(persisted.rows[0]!.revision, 2);
      const snapshotPayload = persisted.rows[0]!.snapshot_payload;
      assert.deepEqual(Object.keys(snapshotPayload).sort(), ["deletedAt", "id", "revision"]);
      assert.equal(snapshotPayload.id, memoryId);
      assert.equal(snapshotPayload.revision, 2);
      assert.equal(typeof snapshotPayload.deletedAt, "string");
      assert.deepEqual(persisted.rows[0]!.change_payload, snapshotPayload);
      const audit = await client.query<{ title: string; content: string; change_type: string }>(
        `SELECT title,content,change_type FROM memory_revisions
        WHERE memory_id=$1 AND revision=2`,
        [memoryId],
      );
      assert.deepEqual(audit.rows[0], {
        title: "敏感标题",
        content: "敏感正文",
        change_type: "FORGET",
      });
      assert.equal(
        Number(
          (
            await client.query(
              `SELECT COUNT(*)::int AS count FROM memory_sources WHERE memory_id=$1`,
              [memoryId],
            )
          ).rows[0]!.count,
        ),
        1,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);

test(
  "bootstrap 跨事务分页回填并用冻结 watermark 收敛页间写入",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const ownerId = randomUUID();
    const recordIdPrefix = randomUUID().slice(0, 24);
    const firstRecordId = `${recordIdPrefix}000000000100`;
    const secondRecordId = `${recordIdPrefix}000000000200`;
    const betweenPagesRecordId = `${recordIdPrefix}000000000001`;
    const now = "2026-08-21T00:00:00.000Z";
    const tokenSecret = "bootstrap-integration-secret";
    const nowMs = Date.now();
    let deviceId = "";

    const bootstrapPage = async (pageToken?: string) => {
      const client = await pool.connect();
      let open = false;
      try {
        await client.query("BEGIN");
        open = true;
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const page = await bootstrapSyncWithClient(client, ownerId, deviceId, {
          pageToken,
          backfillPageSize: 1,
          snapshotPageSize: 1,
          tokenSecret,
          nowMs,
        });
        await client.query("COMMIT");
        open = false;
        return page;
      } finally {
        if (open) await client.query("ROLLBACK");
        client.release();
      }
    };

    try {
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          `INSERT INTO users
             (id,username,display_name,password_hash,role,avatar_color)
           VALUES ($1,$2,'bootstrap 分页测试用户','test','USER','#6757E8')`,
          [ownerId, `bootstrap_page_${ownerId.replaceAll("-", "")}`],
        );
        const device = await registerSyncDeviceWithClient(setup, ownerId, {
          installationId: randomUUID(),
          name: "bootstrap-page-device",
          platform: "TEST",
          appVersion: "1",
        });
        deviceId = device.id;
        // 模拟 Stage4 上线前已有但尚未写 sync projection 的业务行。
        await setup.query(
          `INSERT INTO personal_records (id,owner_id,title,content,revision)
           VALUES ($1,$3,'旧记录一','正文一',1),($2,$3,'旧记录二','正文二',1)`,
          [firstRecordId, secondRecordId, ownerId],
        );
        await setup.query("COMMIT");
      } catch (error) {
        await setup.query("ROLLBACK");
        throw error;
      } finally {
        setup.release();
      }

      let page = await bootstrapPage();
      assert.equal(page.phase, "BACKFILL");
      assert.equal(page.watermark, "0");
      assert.equal(page.cursor, null);
      assert.equal(page.changes.length, 0);
      assert.ok(page.nextPageToken);
      const afterFirstBackfill = await pool.query<{ snapshots: number; cursor: string }>(
        `SELECT
           (SELECT COUNT(*)::int FROM sync_entity_snapshots WHERE owner_id=$1) AS snapshots,
           (SELECT last_sequence::text FROM sync_cursors WHERE owner_id=$1 AND device_id=$2) AS cursor`,
        [ownerId, deviceId],
      );
      assert.deepEqual(afterFirstBackfill.rows[0], { snapshots: 1, cursor: "0" });

      let backfillPages = 1;
      while (page.phase === "BACKFILL") {
        page = await bootstrapPage(page.nextPageToken!);
        backfillPages += 1;
        assert.equal(page.watermark, "0");
        if (page.phase === "BACKFILL") {
          assert.equal(page.cursor, null);
          assert.equal(page.changes.length, 0);
        }
        assert.ok(backfillPages < 10);
      }
      assert.ok(backfillPages >= 2);
      assert.equal(page.phase, "SNAPSHOT");
      assert.equal(page.changes.length, 1);
      assert.equal(page.cursor, null);
      assert.equal(page.hasMore, true);

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        const createBetweenPages: SyncOperation = {
          operationId: randomUUID(),
          entityType: "PERSONAL_RECORD",
          entityId: betweenPagesRecordId,
          operation: "UPSERT",
          baseRevision: null,
          payload: { title: "页间新增", content: "必须由冻结水位后的 pull 收敛" },
          deviceCreatedAt: now,
        };
        await pushSyncOperationsWithClient(writer, ownerId, deviceId, [createBetweenPages]);
        await writer.query("COMMIT");
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }

      const bootstrapEntityIds = page.changes.map((change) => change.entityId);
      while (page.hasMore) {
        page = await bootstrapPage(page.nextPageToken!);
        assert.equal(page.phase, "SNAPSHOT");
        assert.equal(page.watermark, "0");
        bootstrapEntityIds.push(...page.changes.map((change) => change.entityId));
      }
      assert.equal(page.cursor, "0");
      assert.equal(page.nextPageToken, null);
      assert.deepEqual(bootstrapEntityIds.sort(), [firstRecordId, secondRecordId]);

      const pullClient = await pool.connect();
      try {
        await pullClient.query("BEGIN");
        const pulled = await pullSyncChangesWithClient(pullClient, ownerId, deviceId, 0n, 500);
        await pullClient.query("COMMIT");
        assert.equal(
          pulled.changes.some((change) => change.entityId === betweenPagesRecordId),
          true,
        );
        assert.ok(BigInt(pulled.cursor) > 0n);
      } catch (error) {
        await pullClient.query("ROLLBACK");
        throw error;
      } finally {
        pullClient.release();
      }
    } finally {
      await pool.query(`DELETE FROM users WHERE id=$1`, [ownerId]);
      await pool.end();
    }
  },
);
