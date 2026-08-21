package com.nearchat.mobile

import androidx.room.withTransaction

/** 可重放的命名空间迁移；同账号必须是 no-op，否则源清理会删除目标数据。 */
suspend fun reassignOfflineProfile(
    database: OfflineDatabase,
    fromKey: String,
    toKey: String,
) {
    if (fromKey == toKey) return
    database.withTransaction {
        val dao = database.offline()
        dao.reassignTasks(fromKey, toKey)
        dao.reassignReminders(fromKey, toKey)
        dao.reassignRecords(fromKey, toKey)
        dao.reassignMemories(fromKey, toKey)
        dao.reassignAssistants(fromKey, toKey)
        dao.reassignThreads(fromKey, toKey)
        dao.reassignMessages(fromKey, toKey)
        dao.reassignSearch(fromKey, toKey)
        dao.reassignOutbox(fromKey, toKey)
        dao.reassignConflicts(fromKey, toKey)
        // UPDATE OR IGNORE 让 journal 恢复可重复执行；目标已有同 ID 时以目标为准。
        dao.deleteTasksForAccount(fromKey)
        dao.deleteRemindersForAccount(fromKey)
        dao.deleteRecordsForAccount(fromKey)
        dao.deleteMemoriesForAccount(fromKey)
        dao.deleteAssistantsForAccount(fromKey)
        dao.deleteThreadsForAccount(fromKey)
        dao.deleteMessagesForAccount(fromKey)
        dao.deleteSearchForAccount(fromKey)
        dao.deleteOutboxForAccount(fromKey)
        dao.deleteConflictsForAccount(fromKey)
    }
}
