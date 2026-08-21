package com.nearchat.mobile

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class OfflineDatabaseInstrumentedTest {
    private lateinit var database: OfflineDatabase

    @Before
    fun createDatabase() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, OfflineDatabase::class.java).build()
    }

    @After
    fun closeDatabase() {
        database.close()
    }

    @Test
    fun structuredRecordCanBeFoundThroughFts() = runBlocking {
        val payload = """{"id":"00000000-0000-4000-8000-000000000010","title":"离线发布计划","content":"周五前完成验收","revision":0,"createdAt":"2026-08-21T00:00:00.000Z","updatedAt":"2026-08-21T00:00:00.000Z"}"""
        database.offline().save(
            PersonalRecordRow(
                accountKey = "local-test",
                id = "00000000-0000-4000-8000-000000000010",
                title = "离线发布计划",
                content = "周五前完成验收",
                revision = 0,
                createdAt = "2026-08-21T00:00:00.000Z",
                updatedAt = "2026-08-21T00:00:00.000Z",
                payload = payload,
            ),
        )
        database.offline().insertSearch(
            MobileSearchRow(
                accountKey = "local-test",
                entityType = "PERSONAL_RECORD",
                entityId = "00000000-0000-4000-8000-000000000010",
                title = "离线发布计划",
                body = "周五前完成验收",
            ),
        )

        val hits = database.offline().search(
            accountKey = "local-test",
            matchQuery = "\"离线发布计划\"*",
            entityTypes = listOf("PERSONAL_RECORD"),
            nowIso = "2026-08-21T00:00:00.000Z",
            limit = 10,
        )
        assertEquals(1, hits.size)

        val titleSubstringHits = database.offline().searchSubstring(
            accountKey = "local-test",
            likeQuery = "%发布%",
            entityTypes = listOf("PERSONAL_RECORD"),
            nowIso = "2026-08-21T00:00:00.000Z",
            limit = 10,
        )
        val bodySubstringHits = database.offline().searchSubstring(
            accountKey = "local-test",
            likeQuery = "%完成%",
            entityTypes = listOf("PERSONAL_RECORD"),
            nowIso = "2026-08-21T00:00:00.000Z",
            limit = 10,
        )
        assertEquals(listOf("00000000-0000-4000-8000-000000000010"), titleSubstringHits.map(MobileSearchRow::entityId))
        assertEquals(listOf("00000000-0000-4000-8000-000000000010"), bodySubstringHits.map(MobileSearchRow::entityId))
    }

    @Test
    fun deleteConflictRoundTripsLocalOperation() = runBlocking {
        database.offline().saveConflict(
            SyncConflictRow(
                operationId = "00000000-0000-4000-8000-000000000030",
                accountKey = "account-a",
                entityType = "PERSONAL_TASK",
                entityId = "00000000-0000-4000-8000-000000000031",
                reason = "STALE_REVISION",
                serverRevision = 2,
                serverPayload = """{"title":"server"}""",
                serverOperation = "UPSERT",
                localPayload = "{}",
                localOperation = "DELETE",
                createdAt = "2026-08-21T00:00:00.000Z",
            ),
        )

        val stored = database.offline().conflicts("account-a").single()
        assertEquals("DELETE", stored.localOperation)
        assertEquals("UPSERT", stored.serverOperation)
        assertEquals("{}", stored.localPayload)

        assertEquals(
            0,
            database.offline().deleteConflictIfCurrent(
                stored.operationId,
                stored.reason,
                stored.serverRevision + 1,
                stored.serverOperation,
                stored.serverPayload,
            ),
        )
        assertEquals(1, database.offline().conflicts("account-a").size)
        assertEquals(
            1,
            database.offline().deleteConflictIfCurrent(
                stored.operationId,
                stored.reason,
                stored.serverRevision,
                stored.serverOperation,
                stored.serverPayload,
            ),
        )
        assertEquals(0, database.offline().conflicts("account-a").size)
    }

    @Test
    fun conflictPayloadCasNormalizesJavascriptAndAndroidEscaping() = runBlocking {
        val operationId = "00000000-0000-4000-8000-000000000032"
        val storedPayload = canonicalConflictPayload("""{"text":"line\u2028separator"}""")
        database.offline().saveConflict(
            SyncConflictRow(
                operationId = operationId,
                accountKey = "account-a",
                entityType = "PERSONAL_RECORD",
                entityId = "00000000-0000-4000-8000-000000000033",
                reason = "STALE_REVISION",
                serverRevision = 3,
                serverPayload = storedPayload,
                serverOperation = "UPSERT",
                localPayload = "{}",
                localOperation = "UPSERT",
                createdAt = "2026-08-21T00:00:00.000Z",
            ),
        )

        val javascriptPayload = """{"text":"line${'\u2028'}separator"}"""
        assertEquals(storedPayload, canonicalConflictPayload(javascriptPayload))
        assertEquals(
            1,
            database.offline().deleteConflictIfCurrent(
                operationId,
                "STALE_REVISION",
                3,
                "UPSERT",
                canonicalConflictPayload(javascriptPayload),
            ),
        )
    }

    @Test
    fun sameAccountProfileReplayIsNoOp() = runBlocking {
        val row = PersonalRecordRow(
            accountKey = "team-a",
            id = "record-a",
            title = "离线数据",
            content = "必须保留",
            revision = 1,
            createdAt = "2026-08-21T00:00:00.000Z",
            updatedAt = "2026-08-21T00:00:00.000Z",
            payload = """{"id":"record-a"}""",
        )
        database.offline().save(row)

        reassignOfflineProfile(database, "team-a", "team-a")

        assertEquals(listOf(row.payload), database.offline().records("team-a"))
    }

    @Test
    fun memorySearchFiltersLifecycleBeforeLimit() = runBlocking {
        suspend fun addMemory(accountKey: String, id: String, status: String, expiresAt: String?) {
            val payload = """{"id":"$id","title":"项目暗号","content":"同词记忆","scope":"PRIVATE","status":"$status"}"""
            database.offline().save(
                MemoryRow(
                    accountKey = accountKey,
                    id = id,
                    tier = "SHORT_TERM",
                    scope = "PRIVATE",
                    conversationId = null,
                    kind = "FACT",
                    title = "项目暗号",
                    content = "同词记忆",
                    importance = 0.5,
                    status = status,
                    revision = 1,
                    expiresAt = expiresAt,
                    createdAt = "2026-08-20T00:00:00.000Z",
                    updatedAt = "2026-08-20T00:00:00.000Z",
                    deletedAt = null,
                    payload = payload,
                ),
            )
            database.offline().insertSearch(
                MobileSearchRow(
                    accountKey = accountKey,
                    entityType = "MEMORY",
                    entityId = id,
                    title = "项目暗号",
                    body = "同词记忆",
                ),
            )
        }

        addMemory("account-a", "active", "ACTIVE", "2026-08-28T00:00:00.000Z")
        repeat(5) { index -> addMemory("account-a", "archived-$index", "ARCHIVED", null) }
        addMemory("account-a", "expired", "ACTIVE", "2026-08-20T00:00:00.000Z")
        addMemory("account-b", "other-account", "ACTIVE", null)

        val hits = database.offline().search(
            accountKey = "account-a",
            matchQuery = "\"项目暗号\"*",
            entityTypes = listOf("MEMORY"),
            nowIso = "2026-08-21T00:00:00.000Z",
            limit = 5,
        )
        assertEquals(listOf("active"), hits.map(MobileSearchRow::entityId))
    }

    @Test
    fun claimedOutboxSnapshotCannotBeOverwrittenByLaterEdit() = runBlocking {
        fun row(operationId: String, payload: String) = SyncOutboxRow(
            operationId = operationId,
            accountKey = "account-a",
            entityType = "PERSONAL_RECORD",
            entityId = "record-a",
            operation = "UPSERT",
            baseRevision = 1,
            payload = payload,
            deviceCreatedAt = "2026-08-21T00:00:00.000Z",
            attemptCount = 0,
            lastError = null,
            queuedAt = if (operationId == "old") 1 else 2,
        )
        database.offline().saveOutbox(row("old", """{"content":"old"}"""))

        val claimed = claimSyncOutboxBatch(database, "account-a")
        assertEquals(listOf("old"), claimed.map(SyncOutboxRow::operationId))
        assertEquals(null, database.offline().unattemptedOutbox("account-a", "PERSONAL_RECORD", "record-a"))

        database.offline().saveOutbox(row("new", """{"content":"new"}"""))
        database.offline().deleteOutbox(listOf("old"))
        val remaining = database.offline().allOutbox("account-a")
        assertEquals(listOf("new"), remaining.map(SyncOutboxRow::operationId))
        assertEquals("""{"content":"new"}""", remaining.single().payload)
    }

    @Test
    fun appliedAckKeepsLaterReminderEditAndRebasesItsOutboxAtomically() = runBlocking {
        val localPayload = """{"id":"reminder-a","title":"new local","note":"","scheduledAt":"2026-08-22T03:00:00.000Z","completedAt":null,"notifiedAt":null,"revision":3,"createdAt":"2026-08-21T00:00:00.000Z","updatedAt":"2026-08-21T00:01:00.000Z"}"""
        val remotePayload = """{"id":"reminder-a","title":"old acknowledged","note":"","scheduledAt":"2026-08-22T01:00:00.000Z","completedAt":null,"notifiedAt":null,"revision":4,"createdAt":"2026-08-21T00:00:00.000Z","updatedAt":"2026-08-21T00:02:00.000Z"}"""
        database.offline().save(
            PersonalReminderRow(
                "account-a", "reminder-a", "new local", "", "2026-08-22T03:00:00.000Z",
                null, null, 3, "2026-08-21T00:00:00.000Z", "2026-08-21T00:01:00.000Z", localPayload,
            ),
        )
        fun outbox(id: String, queuedAt: Long, attemptCount: Int) = SyncOutboxRow(
            operationId = id,
            accountKey = "account-a",
            entityType = "PERSONAL_REMINDER",
            entityId = "reminder-a",
            operation = "UPSERT",
            baseRevision = 3,
            payload = localPayload,
            deviceCreatedAt = "2026-08-21T00:01:00.000Z",
            attemptCount = attemptCount,
            lastError = null,
            queuedAt = queuedAt,
        )
        database.offline().saveOutbox(outbox("old-operation", 1, 1))
        database.offline().saveOutbox(outbox("new-operation", 2, 0))

        val applied = settleRemoteChangeInTransaction(
            database,
            "account-a",
            "PERSONAL_REMINDER",
            "reminder-a",
            4,
            listOf("old-operation"),
        ) {
            database.offline().save(
                PersonalReminderRow(
                    "account-a", "reminder-a", "old acknowledged", "", "2026-08-22T01:00:00.000Z",
                    null, null, 4, "2026-08-21T00:00:00.000Z", "2026-08-21T00:02:00.000Z", remotePayload,
                ),
            )
        }

        assertFalse(applied)
        assertEquals(localPayload, database.offline().reminder("account-a", "reminder-a"))
        val remaining = database.offline().allOutbox("account-a").single()
        assertEquals("new-operation", remaining.operationId)
        assertEquals(4, remaining.baseRevision)
    }

    @Test
    fun largeValidMessagesAreSplitByUtf8PushBudget() {
        val rows = (0 until 24).map { index ->
            SyncOutboxRow(
                operationId = "00000000-0000-4000-8000-${index.toString().padStart(12, '0')}",
                accountKey = "account-a",
                entityType = "ASSISTANT_MESSAGE",
                entityId = "10000000-0000-4000-8000-${index.toString().padStart(12, '0')}",
                operation = "UPSERT",
                baseRevision = null,
                payload = JSONObject()
                    .put("content", "中".repeat(50_000))
                    .put("sources", JSONArray())
                    .toString(),
                deviceCreatedAt = "2026-08-21T00:00:00.000Z",
                attemptCount = 0,
                lastError = null,
                queuedAt = index.toLong(),
            )
        }
        val batches = splitSyncOutboxBatches(rows, "device-a")
        assertTrue(batches.size > 1)
        assertEquals(rows.map(SyncOutboxRow::operationId), batches.flatten().map(SyncOutboxRow::operationId))
        batches.forEach { batch ->
            val bytes = JSONObject()
                .put("deviceId", "device-a")
                .put("operations", JSONArray(batch.map(::syncOperationJson)))
                .toString()
                .toByteArray(Charsets.UTF_8)
                .size
            assertTrue(bytes <= SYNC_PUSH_BODY_BUDGET_BYTES)
        }
    }
}
