package com.nearchat.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class BackgroundPushDispositionTest {
    private fun row(id: String, entityId: String) = SyncOutboxRow(
        operationId = id,
        accountKey = "account-a",
        entityType = "PERSONAL_RECORD",
        entityId = entityId,
        operation = "UPSERT",
        baseRevision = 1,
        payload = "{}",
        deviceCreatedAt = "2026-08-21T00:00:00.000Z",
        attemptCount = 1,
        lastError = null,
        queuedAt = 1,
    )

    @Test
    fun mixedResponseAcknowledgesOnlyAppliedOperationsAndNeverConflicts() {
        val applied = row("applied", "record-applied")
        val conflicted = row("conflicted", "record-conflicted")

        assertEquals(
            listOf("applied"),
            backgroundAcknowledgedOperationIds(
                rows = listOf(applied, conflicted),
                explicitAcknowledged = setOf("applied", "conflicted"),
                appliedKeys = emptySet(),
                conflictIds = setOf("conflicted"),
            ),
        )
    }

    @Test
    fun legacyAppliedFallbackStillExcludesConflictOperations() {
        val applied = row("applied", "record-applied")
        val conflicted = row("conflicted", "record-conflicted")

        assertEquals(
            listOf("applied"),
            backgroundAcknowledgedOperationIds(
                rows = listOf(applied, conflicted),
                explicitAcknowledged = null,
                appliedKeys = setOf("PERSONAL_RECORD\u0000record-applied\u0000UPSERT"),
                conflictIds = setOf("conflicted"),
            ),
        )
    }
}
