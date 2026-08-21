package com.nearchat.mobile

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** v1 的 JSON 总表仅用于无损迁移，所有新读写都进入下方的领域表。 */
@Entity(tableName = "offline_entities", primaryKeys = ["entityType", "id"])
data class LegacyOfflineEntity(
    val entityType: String,
    val id: String,
    val value: String,
    val updatedAt: Long,
)

@Entity(tableName = "personal_tasks", primaryKeys = ["accountKey", "id"])
data class PersonalTaskRow(
    val accountKey: String,
    val id: String,
    val title: String,
    val note: String,
    val dueAt: String?,
    val completedAt: String?,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val payload: String,
)

@Entity(tableName = "personal_reminders", primaryKeys = ["accountKey", "id"])
data class PersonalReminderRow(
    val accountKey: String,
    val id: String,
    val title: String,
    val note: String,
    val scheduledAt: String,
    val completedAt: String?,
    val notifiedAt: String?,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val payload: String,
)

@Entity(tableName = "personal_records", primaryKeys = ["accountKey", "id"])
data class PersonalRecordRow(
    val accountKey: String,
    val id: String,
    val title: String,
    val content: String,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val payload: String,
)

@Entity(tableName = "memories", primaryKeys = ["accountKey", "id"])
data class MemoryRow(
    val accountKey: String,
    val id: String,
    val tier: String,
    val scope: String,
    val conversationId: String?,
    val kind: String,
    val title: String,
    val content: String,
    val importance: Double,
    val status: String,
    val revision: Int,
    val expiresAt: String?,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String?,
    val payload: String,
)

@Entity(tableName = "assistants", primaryKeys = ["accountKey", "id"])
data class AssistantRow(
    val accountKey: String,
    val id: String,
    val name: String,
    val description: String,
    val category: String,
    val instructions: String,
    val avatarColor: String,
    val modelId: String?,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val payload: String,
)

@Entity(tableName = "assistant_threads", primaryKeys = ["accountKey", "id"])
data class AssistantThreadRow(
    val accountKey: String,
    val id: String,
    val assistantId: String,
    val title: String,
    val archived: Boolean,
    val isDefault: Boolean,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val payload: String,
)

@Entity(tableName = "assistant_messages", primaryKeys = ["accountKey", "id"])
data class AssistantMessageRow(
    val accountKey: String,
    val id: String,
    val assistantId: String,
    val threadId: String,
    val role: String,
    val content: String,
    val modelId: String?,
    val sources: String,
    val revision: Int,
    val createdAt: String,
    val payload: String,
)

@Entity(tableName = "sync_outbox")
data class SyncOutboxRow(
    @PrimaryKey val operationId: String,
    val accountKey: String,
    val entityType: String,
    val entityId: String,
    val operation: String,
    val baseRevision: Int?,
    val payload: String,
    val deviceCreatedAt: String,
    val attemptCount: Int,
    val lastError: String?,
    val queuedAt: Long,
)

@Entity(tableName = "sync_conflicts")
data class SyncConflictRow(
    @PrimaryKey val operationId: String,
    val accountKey: String,
    val entityType: String,
    val entityId: String,
    val reason: String,
    val serverRevision: Int,
    val serverPayload: String,
    val serverOperation: String,
    val localPayload: String,
    val localOperation: String,
    val createdAt: String,
)

@Entity(tableName = "sync_cursors")
data class SyncCursorRow(
    @PrimaryKey val accountKey: String,
    val cursor: String,
    val updatedAt: Long,
)

@Fts4
@Entity(tableName = "mobile_search")
data class MobileSearchRow(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "rowid")
    val rowId: Int = 0,
    val accountKey: String,
    val entityType: String,
    val entityId: String,
    val title: String,
    val body: String,
)

@Dao
interface OfflineDao {
    @Query("SELECT * FROM offline_entities WHERE entityType = :entityType ORDER BY updatedAt")
    suspend fun legacy(entityType: String): List<LegacyOfflineEntity>

    @Query("DELETE FROM offline_entities WHERE entityType = :entityType")
    suspend fun deleteLegacy(entityType: String)

    @Query("SELECT payload FROM personal_tasks WHERE accountKey = :accountKey ORDER BY updatedAt DESC")
    suspend fun tasks(accountKey: String): List<String>

    @Query("SELECT payload FROM personal_reminders WHERE accountKey = :accountKey ORDER BY scheduledAt")
    suspend fun reminders(accountKey: String): List<String>

    @Query("SELECT payload FROM personal_records WHERE accountKey = :accountKey ORDER BY updatedAt DESC")
    suspend fun records(accountKey: String): List<String>

    @Query("SELECT payload FROM memories WHERE accountKey = :accountKey AND status != 'DELETED' ORDER BY updatedAt DESC")
    suspend fun memories(accountKey: String): List<String>

    @Query("SELECT payload FROM assistants WHERE accountKey = :accountKey ORDER BY updatedAt DESC")
    suspend fun assistants(accountKey: String): List<String>

    @Query("SELECT payload FROM assistant_threads WHERE accountKey = :accountKey ORDER BY updatedAt DESC")
    suspend fun threads(accountKey: String): List<String>

    @Query("SELECT payload FROM assistant_messages WHERE accountKey = :accountKey ORDER BY createdAt")
    suspend fun messages(accountKey: String): List<String>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: PersonalTaskRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: PersonalReminderRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: PersonalRecordRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: MemoryRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: AssistantRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: AssistantThreadRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(row: AssistantMessageRow)

    @Query("DELETE FROM personal_tasks WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteTask(accountKey: String, id: String)

    @Query("DELETE FROM personal_reminders WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteReminder(accountKey: String, id: String)

    @Query("DELETE FROM personal_records WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteRecord(accountKey: String, id: String)

    @Query("DELETE FROM memories WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteMemory(accountKey: String, id: String)

    @Query("DELETE FROM assistants WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteAssistant(accountKey: String, id: String)

    @Query("DELETE FROM assistant_threads WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteThread(accountKey: String, id: String)

    @Query("DELETE FROM assistant_messages WHERE accountKey = :accountKey AND id = :id")
    suspend fun deleteMessage(accountKey: String, id: String)

    @Query("DELETE FROM mobile_search WHERE accountKey = :accountKey AND entityType = :entityType AND entityId = :entityId")
    suspend fun deleteSearch(accountKey: String, entityType: String, entityId: String)

    @Insert
    suspend fun insertSearch(row: MobileSearchRow)

    @Query(
        """SELECT mobile_search.rowid AS rowid, mobile_search.* FROM mobile_search
           LEFT JOIN memories visible_memory
             ON visible_memory.accountKey=mobile_search.accountKey
            AND visible_memory.id=mobile_search.entityId
            AND mobile_search.entityType='MEMORY'
          WHERE mobile_search MATCH :matchQuery
            AND mobile_search.accountKey=:accountKey
            AND mobile_search.entityType IN (:entityTypes)
            AND (
              mobile_search.entityType!='MEMORY' OR
              (visible_memory.scope='PRIVATE' AND visible_memory.status='ACTIVE'
               AND visible_memory.deletedAt IS NULL
               AND (visible_memory.expiresAt IS NULL OR visible_memory.expiresAt>:nowIso))
            )
          ORDER BY mobile_search.rowid DESC LIMIT :limit""",
    )
    suspend fun search(
        accountKey: String,
        matchQuery: String,
        entityTypes: List<String>,
        nowIso: String,
        limit: Int,
    ): List<MobileSearchRow>

    @Query(
        """SELECT mobile_search.rowid AS rowid, mobile_search.* FROM mobile_search
           LEFT JOIN memories visible_memory
             ON visible_memory.accountKey=mobile_search.accountKey
            AND visible_memory.id=mobile_search.entityId
            AND mobile_search.entityType='MEMORY'
          WHERE mobile_search.accountKey=:accountKey
            AND mobile_search.entityType IN (:entityTypes)
            AND (mobile_search.title LIKE :likeQuery ESCAPE '\' OR mobile_search.body LIKE :likeQuery ESCAPE '\')
            AND (
              mobile_search.entityType!='MEMORY' OR
              (visible_memory.scope='PRIVATE' AND visible_memory.status='ACTIVE'
               AND visible_memory.deletedAt IS NULL
               AND (visible_memory.expiresAt IS NULL OR visible_memory.expiresAt>:nowIso))
            )
          ORDER BY mobile_search.rowid DESC LIMIT :limit""",
    )
    suspend fun searchSubstring(
        accountKey: String,
        likeQuery: String,
        entityTypes: List<String>,
        nowIso: String,
        limit: Int,
    ): List<MobileSearchRow>

    @Query("SELECT payload FROM personal_tasks WHERE accountKey = :accountKey AND id = :id")
    suspend fun task(accountKey: String, id: String): String?

    @Query("SELECT payload FROM personal_reminders WHERE accountKey = :accountKey AND id = :id")
    suspend fun reminder(accountKey: String, id: String): String?

    @Query("SELECT payload FROM personal_records WHERE accountKey = :accountKey AND id = :id")
    suspend fun record(accountKey: String, id: String): String?

    @Query("SELECT payload FROM memories WHERE accountKey = :accountKey AND id = :id")
    suspend fun memory(accountKey: String, id: String): String?

    @Query("SELECT payload FROM assistants WHERE accountKey = :accountKey AND id = :id")
    suspend fun assistant(accountKey: String, id: String): String?

    @Query("SELECT payload FROM assistant_threads WHERE accountKey = :accountKey AND id = :id")
    suspend fun thread(accountKey: String, id: String): String?

    @Query("SELECT payload FROM assistant_messages WHERE accountKey = :accountKey AND id = :id")
    suspend fun message(accountKey: String, id: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveOutbox(row: SyncOutboxRow)

    @Query("SELECT * FROM sync_outbox WHERE accountKey = :accountKey ORDER BY queuedAt, operationId LIMIT :limit")
    suspend fun outbox(accountKey: String, limit: Int): List<SyncOutboxRow>

    @Query("SELECT * FROM sync_outbox WHERE accountKey = :accountKey ORDER BY queuedAt, operationId")
    suspend fun allOutbox(accountKey: String): List<SyncOutboxRow>

    @Query("SELECT * FROM sync_outbox WHERE accountKey = :accountKey AND entityType = :entityType AND entityId = :entityId AND attemptCount = 0 ORDER BY queuedAt DESC LIMIT 1")
    suspend fun unattemptedOutbox(accountKey: String, entityType: String, entityId: String): SyncOutboxRow?

    @Query("SELECT * FROM sync_outbox WHERE accountKey = :accountKey AND entityType = :entityType AND entityId = :entityId ORDER BY queuedAt, operationId LIMIT 1")
    suspend fun firstOutboxForEntity(accountKey: String, entityType: String, entityId: String): SyncOutboxRow?

    @Query("UPDATE sync_outbox SET baseRevision = :baseRevision WHERE operationId = :operationId")
    suspend fun rebaseOutbox(operationId: String, baseRevision: Int)

    @Query("UPDATE sync_outbox SET attemptCount = attemptCount + 1, lastError = NULL WHERE operationId IN (:operationIds)")
    suspend fun markOutboxAttempt(operationIds: List<String>)

    @Query("UPDATE sync_outbox SET lastError = :error WHERE operationId IN (:operationIds)")
    suspend fun markOutboxFailed(operationIds: List<String>, error: String)

    @Query("DELETE FROM sync_outbox WHERE operationId IN (:operationIds)")
    suspend fun deleteOutbox(operationIds: List<String>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveConflict(row: SyncConflictRow)

    @Query("SELECT * FROM sync_conflicts WHERE accountKey = :accountKey ORDER BY createdAt DESC")
    suspend fun conflicts(accountKey: String): List<SyncConflictRow>

    @Query("DELETE FROM sync_conflicts WHERE operationId = :operationId")
    suspend fun deleteConflict(operationId: String)

    @Query(
        """DELETE FROM sync_conflicts
             WHERE operationId=:operationId AND reason=:reason
               AND serverRevision=:serverRevision AND serverOperation=:serverOperation
               AND serverPayload=:serverPayload""",
    )
    suspend fun deleteConflictIfCurrent(
        operationId: String,
        reason: String,
        serverRevision: Int,
        serverOperation: String,
        serverPayload: String,
    ): Int

    @Query("SELECT cursor FROM sync_cursors WHERE accountKey = :accountKey")
    suspend fun cursor(accountKey: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveCursor(row: SyncCursorRow)

    @Query("DELETE FROM sync_cursors WHERE accountKey = :accountKey")
    suspend fun deleteCursor(accountKey: String)

    @Query("UPDATE OR IGNORE personal_tasks SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignTasks(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE personal_reminders SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignReminders(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE personal_records SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignRecords(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE memories SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignMemories(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE assistants SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignAssistants(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE assistant_threads SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignThreads(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE assistant_messages SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignMessages(fromKey: String, toKey: String)

    @Query("UPDATE mobile_search SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignSearch(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE sync_outbox SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignOutbox(fromKey: String, toKey: String)

    @Query("UPDATE OR IGNORE sync_conflicts SET accountKey = :toKey WHERE accountKey = :fromKey")
    suspend fun reassignConflicts(fromKey: String, toKey: String)

    @Query("DELETE FROM personal_tasks WHERE accountKey = :accountKey")
    suspend fun deleteTasksForAccount(accountKey: String)

    @Query("DELETE FROM personal_reminders WHERE accountKey = :accountKey")
    suspend fun deleteRemindersForAccount(accountKey: String)

    @Query("DELETE FROM personal_records WHERE accountKey = :accountKey")
    suspend fun deleteRecordsForAccount(accountKey: String)

    @Query("DELETE FROM memories WHERE accountKey = :accountKey")
    suspend fun deleteMemoriesForAccount(accountKey: String)

    @Query("DELETE FROM assistants WHERE accountKey = :accountKey")
    suspend fun deleteAssistantsForAccount(accountKey: String)

    @Query("DELETE FROM assistant_threads WHERE accountKey = :accountKey")
    suspend fun deleteThreadsForAccount(accountKey: String)

    @Query("DELETE FROM assistant_messages WHERE accountKey = :accountKey")
    suspend fun deleteMessagesForAccount(accountKey: String)

    @Query("DELETE FROM mobile_search WHERE accountKey = :accountKey")
    suspend fun deleteSearchForAccount(accountKey: String)

    @Query("DELETE FROM sync_outbox WHERE accountKey = :accountKey")
    suspend fun deleteOutboxForAccount(accountKey: String)

    @Query("DELETE FROM sync_conflicts WHERE accountKey = :accountKey")
    suspend fun deleteConflictsForAccount(accountKey: String)
}

@Database(
    entities = [
        LegacyOfflineEntity::class,
        PersonalTaskRow::class,
        PersonalReminderRow::class,
        PersonalRecordRow::class,
        MemoryRow::class,
        AssistantRow::class,
        AssistantThreadRow::class,
        AssistantMessageRow::class,
        SyncOutboxRow::class,
        SyncConflictRow::class,
        SyncCursorRow::class,
        MobileSearchRow::class,
    ],
    version = 3,
    exportSchema = true,
)
abstract class OfflineDatabase : RoomDatabase() {
    abstract fun offline(): OfflineDao
}

/** v1 仅有 offline_entities；v2 增量建表并保留旧表供插件首次读取时迁移。 */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(database: SupportSQLiteDatabase) {
        val statements = listOf(
            "CREATE TABLE IF NOT EXISTS personal_tasks (accountKey TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL, dueAt TEXT, completedAt TEXT, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS personal_reminders (accountKey TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL, scheduledAt TEXT NOT NULL, completedAt TEXT, notifiedAt TEXT, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS personal_records (accountKey TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS memories (accountKey TEXT NOT NULL, id TEXT NOT NULL, tier TEXT NOT NULL, scope TEXT NOT NULL, conversationId TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, expiresAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS assistants (accountKey TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, instructions TEXT NOT NULL, avatarColor TEXT NOT NULL, modelId TEXT, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS assistant_threads (accountKey TEXT NOT NULL, id TEXT NOT NULL, assistantId TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL, isDefault INTEGER NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS assistant_messages (accountKey TEXT NOT NULL, id TEXT NOT NULL, assistantId TEXT NOT NULL, threadId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, modelId TEXT, sources TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(accountKey, id))",
            "CREATE TABLE IF NOT EXISTS sync_outbox (operationId TEXT NOT NULL, accountKey TEXT NOT NULL, entityType TEXT NOT NULL, entityId TEXT NOT NULL, operation TEXT NOT NULL, baseRevision INTEGER, payload TEXT NOT NULL, deviceCreatedAt TEXT NOT NULL, attemptCount INTEGER NOT NULL, lastError TEXT, queuedAt INTEGER NOT NULL, PRIMARY KEY(operationId))",
            "CREATE TABLE IF NOT EXISTS sync_conflicts (operationId TEXT NOT NULL, accountKey TEXT NOT NULL, entityType TEXT NOT NULL, entityId TEXT NOT NULL, reason TEXT NOT NULL, serverRevision INTEGER NOT NULL, serverPayload TEXT NOT NULL, localPayload TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(operationId))",
            "CREATE TABLE IF NOT EXISTS sync_cursors (accountKey TEXT NOT NULL, cursor TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(accountKey))",
            "CREATE VIRTUAL TABLE IF NOT EXISTS mobile_search USING FTS4(accountKey, entityType, entityId, title, body)",
        )
        statements.forEach(database::execSQL)
    }
}

/** v3 记录产生冲突的本地操作类型；旧记录按 UPSERT 兼容，避免升级丢失冲突。 */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL(
            "ALTER TABLE sync_conflicts ADD COLUMN localOperation TEXT NOT NULL DEFAULT 'UPSERT'",
        )
        database.execSQL(
            "ALTER TABLE sync_conflicts ADD COLUMN serverOperation TEXT NOT NULL DEFAULT 'UPSERT'",
        )
        // v2 的 DELETE outbox payload 固定为 {}，而所有合法 UPSERT 均有领域必填字段。
        database.execSQL(
            "UPDATE sync_conflicts SET localOperation='DELETE' WHERE trim(localPayload)='{}'",
        )
        database.execSQL(
            "UPDATE sync_conflicts SET serverOperation='DELETE' " +
                "WHERE reason='ENTITY_DELETED' OR (serverRevision=0 AND trim(serverPayload)='{}') " +
                // 正常 MEMORY payload 也有 deletedAt:null；只有非空字符串才是 tombstone。
                "OR serverPayload LIKE '%\"deletedAt\":\"%' " +
                "OR serverPayload LIKE '%\"status\":\"DELETED\"%'",
        )
    }
}
