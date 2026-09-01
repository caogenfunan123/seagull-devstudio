package com.dsharnessmobile.shell

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Probes the local dsh web engine from the shell side.
 * Seagull fork: engine port moved to 32080 (upstream uses 3080, which the
 * original dsh-mobile instance on the same device also binds — two engines
 * would fight for 3080). Kept in one constant so probe/start/URL all agree.
 */
object EngineProbe {

  const val ENGINE_PORT = 32080
  const val ENGINE_URL = "http://127.0.0.1:$ENGINE_PORT"

  /**
   * One-shot reachability probe. Safe on any thread (never the main thread).
   * @param timeoutMs connect+read budget per attempt.
   * @return JSON: {running: Boolean, latencyMs: Int, error?: String}
   */
  fun check(timeoutMs: Int = 800): JSONObject {
    return try {
      val conn = URL(ENGINE_URL).openConnection() as HttpURLConnection
      conn.connectTimeout = timeoutMs
      conn.readTimeout = timeoutMs
      conn.requestMethod = "GET"
      val start = System.currentTimeMillis()
      val code = conn.responseCode
      conn.disconnect()
      JSONObject()
        .put("running", code == 200)
        .put("latencyMs", System.currentTimeMillis() - start)
    } catch (e: Exception) {
      JSONObject().put("running", false).put("error", e.message ?: "unknown")
    }
  }
}
