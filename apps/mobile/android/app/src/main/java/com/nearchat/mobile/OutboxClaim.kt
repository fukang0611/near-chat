package com.nearchat.mobile

import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject

const val SYNC_PUSH_BODY_BUDGET_BYTES = 768 * 1024

/**
 * 在一个 Room 事务中选择并认领发送快照。认领后 attemptCount>0，随后对同一实体的编辑
 * 必须创建新 operationId，因此旧 HTTP 响应不可能删除承载新内容的 outbox 行。
 */
suspend fun claimSyncOutboxBatch(
    database: OfflineDatabase,
    accountKey: String,
    limit: Int = 100,
): List<SyncOutboxRow> = database.withTransaction {
    val selected = selectSyncOutboxBatch(database.offline().allOutbox(accountKey), limit)
    if (selected.isNotEmpty()) {
        database.offline().markOutboxAttempt(selected.map(SyncOutboxRow::operationId))
    }
    selected
}

fun selectSyncOutboxBatch(rows: List<SyncOutboxRow>, limit: Int = 100): List<SyncOutboxRow> {
    val seen = mutableSetOf<String>()
    return rows.asSequence()
        .filter { seen.add("${it.entityType}\u0000${it.entityId}") }
        .withIndex()
        .sortedWith(compareBy<IndexedValue<SyncOutboxRow>>({ syncPriority(it.value) }, { it.index }))
        .take(limit.coerceIn(1, 100))
        .map(IndexedValue<SyncOutboxRow>::value)
        .toList()
}

fun syncOperationJson(row: SyncOutboxRow): JSONObject = JSONObject()
    .put("operationId", row.operationId)
    .put("entityType", row.entityType)
    .put("entityId", row.entityId)
    .put("operation", row.operation)
    .put("baseRevision", row.baseRevision ?: JSONObject.NULL)
    .put("payload", JSONObject(row.payload))
    .put("deviceCreatedAt", row.deviceCreatedAt)

private fun syncPushBodyBytes(deviceId: String, rows: List<SyncOutboxRow>): Int = JSONObject()
    .put("deviceId", deviceId)
    .put("operations", JSONArray(rows.map(::syncOperationJson)))
    .toString()
    .toByteArray(Charsets.UTF_8)
    .size

fun splitSyncOutboxBatches(
    rows: List<SyncOutboxRow>,
    deviceId: String,
    maxBytes: Int = SYNC_PUSH_BODY_BUDGET_BYTES,
): List<List<SyncOutboxRow>> {
    require(maxBytes > 0) { "同步字节预算无效" }
    val batches = mutableListOf<List<SyncOutboxRow>>()
    var current = mutableListOf<SyncOutboxRow>()
    rows.forEach { row ->
        val candidate = (current + row)
        if (syncPushBodyBytes(deviceId, candidate) <= maxBytes) {
            current.add(row)
        } else {
            require(current.isNotEmpty()) { "单项同步数据超过安全传输上限" }
            batches.add(current)
            current = mutableListOf(row)
            require(syncPushBodyBytes(deviceId, current) <= maxBytes) {
                "单项同步数据超过安全传输上限"
            }
        }
    }
    if (current.isNotEmpty()) batches.add(current)
    return batches
}

fun backgroundAcknowledgedOperationIds(
    rows: List<SyncOutboxRow>,
    explicitAcknowledged: Set<String>?,
    appliedKeys: Set<String>,
    conflictIds: Set<String>,
): List<String> = rows.filter { row ->
    row.operationId !in conflictIds &&
        if (explicitAcknowledged != null) {
            row.operationId in explicitAcknowledged
        } else {
            "${row.entityType}\u0000${row.entityId}\u0000${row.operation}" in appliedKeys
        }
}.map(SyncOutboxRow::operationId)

private fun syncPriority(row: SyncOutboxRow): Int = when (row.entityType) {
    "ASSISTANT" -> if (row.operation == "DELETE") 2 else 0
    "ASSISTANT_THREAD" -> 1
    "ASSISTANT_MESSAGE" -> if (row.operation == "DELETE") 0 else 2
    else -> 0
}
