package com.nearchat.mobile

import androidx.room.Room
import androidx.room.withTransaction
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

private val SUPPORTED_TYPES = setOf(
    "MEMORY",
    "PERSONAL_TASK",
    "PERSONAL_REMINDER",
    "PERSONAL_RECORD",
    "ASSISTANT",
    "ASSISTANT_THREAD",
    "ASSISTANT_MESSAGE",
)

@CapacitorPlugin(name = "OfflineStore")
class OfflineStorePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val databaseHolder = lazy {
        Room.databaseBuilder(context, OfflineDatabase::class.java, "near-chat-offline.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .build()
    }
    private val database by databaseHolder

    override fun handleOnDestroy() {
        scope.cancel()
        if (databaseHolder.isInitialized()) database.close()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun list(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val entityType = entityType(call)
        migrateLegacy(accountKey, entityType)
        val entries = JSArray()
        listValues(accountKey, entityType).forEach { value ->
            val payload = JSONObject(value)
            entries.put(JSObject().put("id", payload.getString("id")).put("value", value))
        }
        JSObject().put("entries", entries)
    }

    @PluginMethod
    fun save(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val entityType = entityType(call)
        val id = required(call, "id")
        val value = required(call, "value")
        val payload = JSONObject(value)
        require(payload.optString("id") == id) { "实体 id 与 payload.id 不一致" }
        val queueSync = call.getBoolean("queueSync", false) == true
        val requestedOperationId = call.getString("operationId") ?: UUID.randomUUID().toString()
        val baseRevision = call.getInt("baseRevision")
        val forceNew = call.getBoolean("forceNewOperation", false) == true
        var operationId: String? = null
        database.withTransaction {
            saveEntity(accountKey, entityType, id, payload, value)
            if (queueSync) {
                val existing = if (forceNew) null else database.offline()
                    .unattemptedOutbox(accountKey, entityType, id)
                operationId = if (existing != null && existing.operation == "UPSERT") {
                    database.offline().saveOutbox(
                        existing.copy(
                            payload = value,
                            deviceCreatedAt = nowIso(),
                            lastError = null,
                        ),
                    )
                    existing.operationId
                } else {
                    database.offline().saveOutbox(
                        SyncOutboxRow(
                            operationId = requestedOperationId,
                            accountKey = accountKey,
                            entityType = entityType,
                            entityId = id,
                            operation = "UPSERT",
                            baseRevision = baseRevision,
                            payload = value,
                            deviceCreatedAt = nowIso(),
                            attemptCount = 0,
                            lastError = null,
                            queuedAt = System.currentTimeMillis(),
                        ),
                    )
                    requestedOperationId
                }
            }
        }
        JSObject().put("operationId", operationId ?: JSONObject.NULL)
    }

    @PluginMethod
    fun remove(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val entityType = entityType(call)
        val id = required(call, "id")
        val queueSync = call.getBoolean("queueSync", false) == true
        val requestedOperationId = call.getString("operationId") ?: UUID.randomUUID().toString()
        val baseRevision = call.getInt("baseRevision")
        var operationId: String? = null
        database.withTransaction {
            deleteEntity(accountKey, entityType, id)
            if (queueSync) {
                val existing = database.offline().unattemptedOutbox(accountKey, entityType, id)
                if (existing != null && existing.operation == "UPSERT" && existing.baseRevision == null) {
                    // 从未离开设备的新实体被删除，不需要给服务端制造无意义 tombstone。
                    database.offline().deleteOutbox(listOf(existing.operationId))
                } else if (existing != null) {
                    database.offline().saveOutbox(
                        existing.copy(
                            operation = "DELETE",
                            payload = "{}",
                            deviceCreatedAt = nowIso(),
                            lastError = null,
                        ),
                    )
                    operationId = existing.operationId
                } else {
                    database.offline().saveOutbox(
                        SyncOutboxRow(
                            operationId = requestedOperationId,
                            accountKey = accountKey,
                            entityType = entityType,
                            entityId = id,
                            operation = "DELETE",
                            baseRevision = baseRevision,
                            payload = "{}",
                            deviceCreatedAt = nowIso(),
                            attemptCount = 0,
                            lastError = null,
                            queuedAt = System.currentTimeMillis(),
                        ),
                    )
                    operationId = requestedOperationId
                }
            }
        }
        JSObject().put("operationId", operationId ?: JSONObject.NULL)
    }

    @PluginMethod
    fun search(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val query = required(call, "query")
        val entityTypes = call.getArray("entityTypes")?.toList<String>()
            ?.filter(SUPPORTED_TYPES::contains)
            .orEmpty()
        require(entityTypes.isNotEmpty()) { "entityTypes 不能为空" }
        val limit = (call.getInt("limit", 50) ?: 50).coerceIn(1, 200)
        val terms = query.trim().split(Regex("\\s+")).map { it.replace("\"", "") }.filter(String::isNotBlank)
        require(terms.isNotEmpty()) { "query 不能为空" }
        val matchQuery = terms.joinToString(" AND ") { "\"$it\"*" }
        val containsCjk = terms.any { term -> term.any { it.code >= 0x2e80 } }
        val likeQuery = terms.joinToString("%", prefix = "%", postfix = "%") { term ->
            term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        }
        val entries = JSArray()
        val hits = if (containsCjk) {
            // SQLite FTS4 的 simple tokenizer 不会把连续中文拆词；中文改走受账号、类型、生命周期
            // 约束且在 LIMIT 前过滤的 LIKE 路径，保证“离线发布”可按“发布”命中。
            database.offline().searchSubstring(accountKey, likeQuery, entityTypes, nowIso(), limit)
        } else {
            database.offline().search(accountKey, matchQuery, entityTypes, nowIso(), limit)
        }
        hits.forEach { hit ->
            valueFor(accountKey, hit.entityType, hit.entityId)?.let { value ->
                entries.put(
                    JSObject()
                        .put("id", hit.entityId)
                        .put("entityType", hit.entityType)
                        .put("value", value),
                )
            }
        }
        JSObject().put("entries", entries)
    }

    @PluginMethod
    fun listOutbox(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val limit = (call.getInt("limit", 500) ?: 500).coerceIn(1, 1000)
        JSObject().put(
            "operations",
            JSArray(database.offline().outbox(accountKey, limit).map(::outboxJson)),
        )
    }

    @PluginMethod
    fun claimOutbox(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        JSObject().put(
            "operations",
            JSArray(claimSyncOutboxBatch(database, accountKey).map(::outboxJson)),
        )
    }

    @PluginMethod
    fun markOutboxAttempt(call: PluginCall) = execute(call) {
        database.offline().markOutboxAttempt(stringList(call, "operationIds"))
        null
    }

    @PluginMethod
    fun markOutboxFailed(call: PluginCall) = execute(call) {
        database.offline().markOutboxFailed(stringList(call, "operationIds"), required(call, "error").take(1000))
        null
    }

    @PluginMethod
    fun acknowledgeOutbox(call: PluginCall) = execute(call) {
        database.offline().deleteOutbox(stringList(call, "operationIds"))
        null
    }

    @PluginMethod
    fun settleRemoteChange(call: PluginCall) = execute(call) {
        val accountKey = required(call, "accountKey")
        val entityType = entityType(call)
        val id = required(call, "id")
        val operation = required(call, "operation")
        require(operation == "UPSERT" || operation == "DELETE") { "不支持的同步操作：$operation" }
        val revision = call.getInt("revision") ?: error("revision 不能为空")
        val acknowledged = call.getArray("acknowledgedOperationIds")
            ?.toList<String>()
            ?.filter(String::isNotBlank)
            .orEmpty()
        val serialized = if (operation == "UPSERT") required(call, "value") else null
        val payload = serialized?.let(::JSONObject)
        if (payload != null) require(payload.optString("id") == id) { "实体 id 与 payload.id 不一致" }

        val applied = settleRemoteChangeInTransaction(
            database = database,
            accountKey = accountKey,
            entityType = entityType,
            entityId = id,
            serverRevision = revision,
            acknowledgedOperationIds = acknowledged,
        ) {
            if (operation == "DELETE") {
                deleteEntity(accountKey, entityType, id)
            } else {
                saveEntity(accountKey, entityType, id, payload!!, serialized!!)
            }
        }
        JSObject().put("applied", applied)
    }

    @PluginMethod
    fun listConflicts(call: PluginCall) = execute(call) {
        val rows = database.offline().conflicts(required(call, "accountKey"))
        JSObject().put("conflicts", JSArray(rows.map(::conflictJson)))
    }

    @PluginMethod
    fun saveConflict(call: PluginCall) = execute(call) {
        val value = JSONObject(required(call, "conflict"))
        database.offline().saveConflict(
            SyncConflictRow(
                operationId = value.getString("operationId"),
                accountKey = value.getString("accountKey"),
                entityType = value.getString("entityType"),
                entityId = value.getString("entityId"),
                reason = value.getString("reason"),
                serverRevision = value.getInt("serverRevision"),
                serverPayload = value.getJSONObject("serverPayload").toString(),
                serverOperation = value.optString("serverOperation", "UPSERT"),
                localPayload = value.getJSONObject("localPayload").toString(),
                localOperation = value.optString("localOperation", "UPSERT"),
                createdAt = value.getString("createdAt"),
            ),
        )
        null
    }

    @PluginMethod
    fun deleteConflict(call: PluginCall) = execute(call) {
        database.offline().deleteConflict(required(call, "operationId"))
        null
    }

    @PluginMethod
    fun deleteConflictIfCurrent(call: PluginCall) = execute(call) {
        val deleted = database.offline().deleteConflictIfCurrent(
            required(call, "operationId"),
            required(call, "reason"),
            call.getInt("serverRevision") ?: error("serverRevision 不能为空"),
            required(call, "serverOperation"),
            canonicalConflictPayload(required(call, "serverPayload")),
        )
        JSObject().put("deleted", deleted > 0)
    }

    @PluginMethod
    fun getCursor(call: PluginCall) = execute(call) {
        JSObject().put("cursor", database.offline().cursor(required(call, "accountKey")))
    }

    @PluginMethod
    fun setCursor(call: PluginCall) = execute(call) {
        database.offline().saveCursor(
            SyncCursorRow(required(call, "accountKey"), required(call, "cursor"), System.currentTimeMillis()),
        )
        null
    }

    @PluginMethod
    fun clearCursor(call: PluginCall) = execute(call) {
        database.offline().deleteCursor(required(call, "accountKey"))
        null
    }

    @PluginMethod
    fun reassignProfile(call: PluginCall) = execute(call) {
        val fromKey = required(call, "fromAccountKey")
        val toKey = required(call, "toAccountKey")
        reassignOfflineProfile(database, fromKey, toKey)
        null
    }

    @PluginMethod
    fun scheduleBackgroundSync(call: PluginCall) = execute(call) {
        val minutes = (call.getInt("intervalMinutes", 15) ?: 15).coerceAtLeast(15)
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val request = PeriodicWorkRequestBuilder<BackgroundSyncWorker>(minutes.toLong(), TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            BackgroundSyncWorker.UNIQUE_NAME,
            ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE,
            request,
        )
        null
    }

    @PluginMethod
    fun cancelBackgroundSync(call: PluginCall) = execute(call) {
        WorkManager.getInstance(context).cancelUniqueWork(BackgroundSyncWorker.UNIQUE_NAME)
        null
    }

    @PluginMethod
    fun consumeBackgroundSyncRequest(call: PluginCall) = execute(call) {
        val preferences = context.getSharedPreferences(BackgroundSyncWorker.PREFERENCES, 0)
        val requested = preferences.getBoolean(BackgroundSyncWorker.REQUESTED, false)
        val reason = preferences.getString(BackgroundSyncWorker.REASON, null)
        val error = preferences.getString(BackgroundSyncWorker.LAST_ERROR, null)
        if (requested) {
            preferences.edit()
                .putBoolean(BackgroundSyncWorker.REQUESTED, false)
                .remove(BackgroundSyncWorker.REASON)
                .remove(BackgroundSyncWorker.LAST_ERROR)
                .apply()
        }
        JSObject()
            .put("requested", requested)
            .put("reason", reason ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)
    }

    @PluginMethod
    fun networkPolicy(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("allowCleartext", BuildConfig.DEBUG)
                .put("buildType", if (BuildConfig.DEBUG) "debug" else "release"),
        )
    }

    private fun execute(call: PluginCall, block: suspend () -> JSObject?) {
        scope.launch {
            try {
                val result = block()
                if (result == null) call.resolve() else call.resolve(result)
            } catch (error: Exception) {
                call.reject(error.message ?: "本地数据库操作失败", error)
            }
        }
    }

    private fun required(call: PluginCall, name: String): String =
        call.getString(name)?.trim()?.takeIf(String::isNotEmpty)
            ?: throw IllegalArgumentException("$name 不能为空")

    private fun entityType(call: PluginCall): String = required(call, "entityType").also {
        require(SUPPORTED_TYPES.contains(it)) { "不支持的实体类型：$it" }
    }

    private fun stringList(call: PluginCall, name: String): List<String> =
        call.getArray(name)?.toList<String>()?.filter(String::isNotBlank)
            ?: throw IllegalArgumentException("$name 不能为空")

    private suspend fun migrateLegacy(accountKey: String, entityType: String) {
        if (entityType !in setOf("PERSONAL_TASK", "PERSONAL_REMINDER", "PERSONAL_RECORD")) return
        val legacy = database.offline().legacy(entityType)
        if (legacy.isEmpty()) return
        database.withTransaction {
            legacy.forEach { row ->
                val value = JSONObject(row.value)
                saveEntity(accountKey, entityType, row.id, value, row.value)
            }
            database.offline().deleteLegacy(entityType)
        }
    }

    private suspend fun listValues(accountKey: String, entityType: String): List<String> = when (entityType) {
        "PERSONAL_TASK" -> database.offline().tasks(accountKey)
        "PERSONAL_REMINDER" -> database.offline().reminders(accountKey)
        "PERSONAL_RECORD" -> database.offline().records(accountKey)
        "MEMORY" -> database.offline().memories(accountKey)
        "ASSISTANT" -> database.offline().assistants(accountKey)
        "ASSISTANT_THREAD" -> database.offline().threads(accountKey)
        "ASSISTANT_MESSAGE" -> database.offline().messages(accountKey)
        else -> emptyList()
    }

    private suspend fun valueFor(accountKey: String, entityType: String, id: String): String? = when (entityType) {
        "PERSONAL_TASK" -> database.offline().task(accountKey, id)
        "PERSONAL_REMINDER" -> database.offline().reminder(accountKey, id)
        "PERSONAL_RECORD" -> database.offline().record(accountKey, id)
        "MEMORY" -> database.offline().memory(accountKey, id)
        "ASSISTANT" -> database.offline().assistant(accountKey, id)
        "ASSISTANT_THREAD" -> database.offline().thread(accountKey, id)
        "ASSISTANT_MESSAGE" -> database.offline().message(accountKey, id)
        else -> null
    }

    private suspend fun saveEntity(
        accountKey: String,
        entityType: String,
        id: String,
        value: JSONObject,
        serialized: String,
    ) {
        val dao = database.offline()
        when (entityType) {
            "PERSONAL_TASK" -> dao.save(
                PersonalTaskRow(
                    accountKey, id, value.string("title"), value.string("note"), value.nullable("dueAt"),
                    value.nullable("completedAt"), value.optInt("revision"), value.string("createdAt"),
                    value.string("updatedAt"), serialized,
                ),
            )
            "PERSONAL_REMINDER" -> dao.save(
                PersonalReminderRow(
                    accountKey, id, value.string("title"), value.string("note"), value.string("scheduledAt"),
                    value.nullable("completedAt"), value.nullable("notifiedAt"), value.optInt("revision"),
                    value.string("createdAt"), value.string("updatedAt"), serialized,
                ),
            )
            "PERSONAL_RECORD" -> dao.save(
                PersonalRecordRow(
                    accountKey, id, value.string("title"), value.string("content"), value.optInt("revision"),
                    value.string("createdAt"), value.string("updatedAt"), serialized,
                ),
            )
            "MEMORY" -> dao.save(
                MemoryRow(
                    accountKey, id, value.string("tier"), value.string("scope"), value.nullable("conversationId"),
                    value.string("kind"), value.string("title"), value.string("content"), value.optDouble("importance"),
                    value.string("status"), value.optInt("revision"), value.nullable("expiresAt"),
                    value.string("createdAt"), value.string("updatedAt"), value.nullable("deletedAt"), serialized,
                ),
            )
            "ASSISTANT" -> dao.save(
                AssistantRow(
                    accountKey, id, value.string("name"), value.string("description"), value.string("category"),
                    value.string("instructions"), value.string("avatarColor"), value.nullable("modelId"),
                    value.optInt("revision"), value.string("createdAt"), value.string("updatedAt"), serialized,
                ),
            )
            "ASSISTANT_THREAD" -> dao.save(
                AssistantThreadRow(
                    accountKey, id, value.string("assistantId"), value.string("title"), value.optBoolean("archived"),
                    value.optBoolean("isDefault"), value.optInt("revision"), value.string("createdAt"),
                    value.string("updatedAt"), serialized,
                ),
            )
            "ASSISTANT_MESSAGE" -> dao.save(
                AssistantMessageRow(
                    accountKey, id, value.string("assistantId"), value.string("threadId"), value.string("role"),
                    value.string("content"), value.nullable("modelId"), value.optJSONArray("sources")?.toString() ?: "[]",
                    value.optInt("revision"), value.string("createdAt"), serialized,
                ),
            )
        }
        dao.deleteSearch(accountKey, entityType, id)
        val (title, body) = searchText(entityType, value)
        if (title.isNotBlank() || body.isNotBlank()) {
            dao.insertSearch(MobileSearchRow(accountKey = accountKey, entityType = entityType, entityId = id, title = title, body = body))
        }
    }

    private suspend fun deleteEntity(accountKey: String, entityType: String, id: String) {
        val dao = database.offline()
        when (entityType) {
            "PERSONAL_TASK" -> dao.deleteTask(accountKey, id)
            "PERSONAL_REMINDER" -> dao.deleteReminder(accountKey, id)
            "PERSONAL_RECORD" -> dao.deleteRecord(accountKey, id)
            "MEMORY" -> dao.deleteMemory(accountKey, id)
            "ASSISTANT" -> dao.deleteAssistant(accountKey, id)
            "ASSISTANT_THREAD" -> dao.deleteThread(accountKey, id)
            "ASSISTANT_MESSAGE" -> dao.deleteMessage(accountKey, id)
        }
        dao.deleteSearch(accountKey, entityType, id)
    }

    private fun searchText(entityType: String, value: JSONObject): Pair<String, String> = when (entityType) {
        "PERSONAL_TASK", "PERSONAL_REMINDER" -> value.string("title") to value.string("note")
        "PERSONAL_RECORD", "MEMORY" -> value.string("title") to value.string("content")
        "ASSISTANT" -> value.string("name") to "${value.string("description")} ${value.string("instructions")}".trim()
        "ASSISTANT_THREAD" -> value.string("title") to ""
        "ASSISTANT_MESSAGE" -> "" to value.string("content")
        else -> "" to ""
    }

    private fun outboxJson(row: SyncOutboxRow): String = JSONObject()
        .put("operationId", row.operationId)
        .put("accountKey", row.accountKey)
        .put("entityType", row.entityType)
        .put("entityId", row.entityId)
        .put("operation", row.operation)
        .put("baseRevision", row.baseRevision ?: JSONObject.NULL)
        .put("payload", JSONObject(row.payload))
        .put("deviceCreatedAt", row.deviceCreatedAt)
        .put("attemptCount", row.attemptCount)
        .put("lastError", row.lastError ?: JSONObject.NULL)
        .toString()

    private fun conflictJson(row: SyncConflictRow): String = JSONObject()
        .put("operationId", row.operationId)
        .put("accountKey", row.accountKey)
        .put("entityType", row.entityType)
        .put("entityId", row.entityId)
        .put("reason", row.reason)
        .put("serverRevision", row.serverRevision)
        .put("serverPayload", JSONObject(row.serverPayload))
        .put("serverOperation", row.serverOperation)
        .put("localPayload", JSONObject(row.localPayload))
        .put("localOperation", row.localOperation)
        .put("createdAt", row.createdAt)
        .toString()

    private fun JSONObject.string(name: String): String =
        if (!has(name) || isNull(name)) "" else optString(name, "")

    private fun JSONObject.nullable(name: String): String? =
        if (!has(name) || isNull(name)) null else optString(name).takeIf(String::isNotEmpty)

    private fun nowIso(): String = java.text.SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        java.util.Locale.US,
    ).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())
}
