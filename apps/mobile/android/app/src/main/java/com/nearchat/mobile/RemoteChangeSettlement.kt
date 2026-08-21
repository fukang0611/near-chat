package com.nearchat.mobile

import androidx.room.withTransaction

/**
 * 精确 ACK、后继 outbox 检查与权威实体写入共用一个 Room 事务。
 * 有后继本地操作时仅提升其 baseRevision，不执行 applyRemote，保证本地编辑不会回退。
 */
suspend fun settleRemoteChangeInTransaction(
    database: OfflineDatabase,
    accountKey: String,
    entityType: String,
    entityId: String,
    serverRevision: Int,
    acknowledgedOperationIds: List<String>,
    applyRemote: suspend () -> Unit,
): Boolean {
    var applied = false
    database.withTransaction {
        val dao = database.offline()
        if (acknowledgedOperationIds.isNotEmpty()) dao.deleteOutbox(acknowledgedOperationIds)
        val pending = dao.firstOutboxForEntity(accountKey, entityType, entityId)
        if (pending == null) {
            applyRemote()
            applied = true
        } else if (acknowledgedOperationIds.isNotEmpty()) {
            dao.rebaseOutbox(
                pending.operationId,
                maxOf(pending.baseRevision ?: serverRevision, serverRevision),
            )
        }
    }
    return applied
}
