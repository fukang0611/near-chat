package com.nearchat.mobile

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod

/** API Key、团队 Token 和账号命名空间只以 Keystore AES-GCM 密文持久化。 */
@CapacitorPlugin(name = "SecureStore")
class SecureStorePlugin : Plugin() {
    private val store by lazy { DeviceSecureStore(context) }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key")?.trim()
        if (key.isNullOrEmpty()) return call.reject("key 不能为空")
        try {
            call.resolve(JSObject().put("value", store.get(key)))
        } catch (error: Exception) {
            store.remove(key)
            call.reject("设备密钥已失效，请重新填写凭据", error)
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")?.trim()
        val value = call.getString("value")
        if (key.isNullOrEmpty() || value == null) return call.reject("key 和 value 均不能为空")
        try {
            store.set(key, value)
            call.resolve()
        } catch (error: Exception) {
            call.reject("安全凭据保存失败", error)
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key")?.trim()
        if (key.isNullOrEmpty()) return call.reject("key 不能为空")
        store.remove(key)
        call.resolve()
    }
}
