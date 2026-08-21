package com.nearchat.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore 封装同时供 Capacitor 插件和无 WebView 的 WorkManager 使用。 */
class DeviceSecureStore(context: Context) {
    private val preferences = context.getSharedPreferences("near-chat-secure", 0)

    fun get(key: String): String? {
        val packed = preferences.getString(key, null) ?: return null
        val bytes = Base64.decode(packed, Base64.NO_WRAP)
        require(bytes.isNotEmpty()) { "安全存储内容损坏" }
        val ivLength = bytes.first().toInt()
        require(ivLength in 1..32 && bytes.size > ivLength + 1) { "安全存储内容损坏" }
        val iv = bytes.copyOfRange(1, 1 + ivLength)
        val encrypted = bytes.copyOfRange(1 + ivLength, bytes.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    fun set(key: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = byteArrayOf(iv.size.toByte()) + iv + encrypted
        check(preferences.edit().putString(key, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
            "安全存储写入失败"
        }
    }

    fun remove(key: String) {
        check(preferences.edit().remove(key).commit()) { "安全存储删除失败" }
    }

    private fun secretKey(): SecretKey {
        val alias = "near-chat-mobile-aes"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }
}
