package com.nearchat.mobile

import android.content.Context
import androidx.room.Room
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * 无 WebView 时直接读取 Keystore + Room，注册设备并幂等推送持久 outbox。
 * 服务端变更拉取与本地 revision 写回仍在前台完成，因此成功后会留下 pull 请求标记。
 */
class BackgroundSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val secure = DeviceSecureStore(applicationContext)
        val accountKey = secure.get("active-account-key") ?: return@withContext Result.success()
        val serverUrl = secure.get("server-url")?.trimEnd('/') ?: return@withContext Result.success()
        val token = secure.get("server-token") ?: return@withContext Result.success()
        val generation = secure.get("profile-generation") ?: return@withContext Result.success()
        val installationId = secure.get("installation-id") ?: return@withContext Result.success()
        if (serverUrl.startsWith("http://") && !BuildConfig.DEBUG) {
            requestForegroundSync("CLEARTEXT_BLOCKED", "正式构建只允许 HTTPS")
            return@withContext Result.success()
        }

        val database = Room.databaseBuilder(
            applicationContext,
            OfflineDatabase::class.java,
            "near-chat-offline.db",
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
        fun profileIsCurrent(): Boolean =
            secure.get("profile-generation") == generation &&
                secure.get("active-account-key") == accountKey &&
                secure.get("server-url")?.trimEnd('/') == serverUrl &&
                secure.get("server-token") == token
        try {
            val deviceId = registerDevice(serverUrl, token, installationId)
            if (!profileIsCurrent()) return@withContext Result.success()
            repeat(100) {
                if (!profileIsCurrent()) return@withContext Result.success()
                val batch = claimSyncOutboxBatch(database, accountKey)
                if (batch.isEmpty()) {
                    requestForegroundPull()
                    return@withContext Result.success()
                }
                for (transferBatch in splitSyncOutboxBatches(batch, deviceId)) {
                    val ids = transferBatch.map(SyncOutboxRow::operationId)
                    if (!profileIsCurrent()) return@withContext Result.success()
                    val response = try {
                        postJson(
                            "$serverUrl/api/sync/push",
                            token,
                            JSONObject()
                                .put("deviceId", deviceId)
                                .put("operations", JSONArray(transferBatch.map(::syncOperationJson))),
                        )
                    } catch (error: Exception) {
                        if (!profileIsCurrent()) return@withContext Result.success()
                        database.offline().markOutboxFailed(
                            ids,
                            (error.message ?: "后台同步失败").take(1000),
                        )
                        return@withContext resultFor(error)
                    }
                    // 请求可能已被服务端接受，但登出/换号后只能保留 operationId 待将来幂等恢复，
                    // 不能再写冲突、ACK 或触发当前账号的前台拉取标记。
                    if (!profileIsCurrent()) return@withContext Result.success()

                    val conflicts = response.optJSONArray("conflicts") ?: JSONArray()
                    val conflictIds = (0 until conflicts.length()).mapNotNull { index ->
                        conflicts.optJSONObject(index)?.optString("operationId")
                            ?.takeIf(String::isNotBlank)
                    }.toSet()
                    val applied = response.optJSONArray("applied") ?: JSONArray()
                    val appliedKeys = (0 until applied.length()).mapNotNull { index ->
                        applied.optJSONObject(index)?.let { change ->
                            val entityType = change.optString("entityType")
                            val entityId = change.optString("entityId")
                            val operation = change.optString("operation", "UPSERT")
                            if (entityType.isBlank() || entityId.isBlank()) null
                            else "$entityType\u0000$entityId\u0000$operation"
                        }
                    }.toSet()
                    val explicitAcknowledged = response.optJSONArray("acknowledgedOperationIds")
                        ?.strings()?.toSet()
                    val acknowledged = backgroundAcknowledgedOperationIds(
                        transferBatch,
                        explicitAcknowledged,
                        appliedKeys,
                        conflictIds,
                    )
                    if (acknowledged.isNotEmpty()) {
                        database.offline().deleteOutbox(acknowledged)
                    }
                    if (conflictIds.isNotEmpty()) {
                        // 后台不能替用户决定冲突，更不能用迟到响应覆盖前台已经刷新的权威版本。
                        // 保留冲突操作供前台在账号级同步锁内重放、拉取并展示。
                        database.offline().markOutboxFailed(
                            conflictIds.filter(ids::contains),
                            "需要在前台处理同步冲突",
                        )
                        requestForegroundSync("CONFLICT_REQUIRED", "需要在前台处理同步冲突")
                        return@withContext Result.success()
                    }
                    if (acknowledged.isEmpty()) {
                        database.offline().markOutboxFailed(ids, "服务端未确认后台同步操作")
                        return@withContext Result.retry()
                    }
                }
            }
            requestForegroundPull()
            Result.retry()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (profileIsCurrent()) resultFor(error) else Result.success()
        } finally {
            database.close()
        }
    }

    private fun registerDevice(serverUrl: String, token: String, installationId: String): String {
        val response = postJson(
            "$serverUrl/api/sync/devices/register",
            token,
            JSONObject()
                .put("installationId", installationId)
                .put("name", "NearChat Android")
                .put("platform", "ANDROID")
                .put("appVersion", "0.2.0"),
        )
        return response.getJSONObject("device").getString("id")
    }

    private fun postJson(url: String, token: String, body: JSONObject): JSONObject {
        val endpoint = URL(url)
        require(endpoint.protocol == "https" || (BuildConfig.DEBUG && endpoint.protocol == "http")) {
            "正式构建只允许 HTTPS"
        }
        val connection = endpoint.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20_000
            connection.readTimeout = 30_000
            connection.doOutput = true
            connection.setRequestProperty("content-type", "application/json")
            connection.setRequestProperty("accept", "application/json")
            connection.setRequestProperty("authorization", "Bearer $token")
            connection.outputStream.use { stream ->
                stream.write(body.toString().toByteArray(Charsets.UTF_8))
            }
            val status = connection.responseCode
            val source = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = source?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw HttpStatusException(status, "团队服务返回 $status")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun JSONArray.strings(): List<String> =
        (0 until length()).mapNotNull { index -> optString(index).takeIf(String::isNotBlank) }

    private fun requestForegroundPull() = requestForegroundSync("PULL_REQUIRED", null)

    /**
     * PeriodicWork 的 failure 是终态。认证/输入类 4xx 留给前台处理并返回 success，
     * 让周期任务保持存活；限流、超时及服务端故障才使用 WorkManager 退避重试。
     */
    private fun resultFor(error: Exception): Result {
        if (error is HttpStatusException) {
            return when (error.status) {
                401, 403 -> {
                    requestForegroundSync("AUTH_REQUIRED", error.message)
                    Result.success()
                }
                408, 425, 429 -> Result.retry()
                in 400..499 -> {
                    requestForegroundSync("REQUEST_REJECTED", error.message)
                    Result.success()
                }
                else -> Result.retry()
            }
        }
        if (error is IllegalArgumentException || error is org.json.JSONException) {
            requestForegroundSync("LOCAL_INPUT_INVALID", error.message)
            return Result.success()
        }
        return Result.retry()
    }

    private fun requestForegroundSync(reason: String, error: String?) {
        val editor = applicationContext.getSharedPreferences(PREFERENCES, 0)
            .edit()
            .putBoolean(REQUESTED, true)
            .putString(REASON, reason)
        if (error.isNullOrBlank()) editor.remove(LAST_ERROR) else editor.putString(LAST_ERROR, error.take(1000))
        editor.apply()
    }

    private fun nowIso(): String = java.text.SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        java.util.Locale.US,
    ).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())

    companion object {
        const val UNIQUE_NAME = "near-chat-background-sync"
        const val PREFERENCES = "near-chat-background-sync"
        const val REQUESTED = "requested"
        const val REASON = "reason"
        const val LAST_ERROR = "last-error"
    }
}

private class HttpStatusException(val status: Int, message: String) : Exception(message)
