package com.nearchat.mobile

import org.json.JSONObject

/** JS 与 org.json 对 U+2028/U+2029 等字符的转义不同，进入 SQL CAS 前统一为 Room 的格式。 */
fun canonicalConflictPayload(value: String): String = JSONObject(value).toString()
