package com.dsharnessmobile.shell

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.io.File

/**
 * 看门狗升级（0.13.0 PRD F2/M3.4）：
 * - 深度探活：HTTP 状态码 + 页面心跳 + 插件状态（EngineProbe 扩展：/api/android/privilege/status
 *   可达表示插件树健康）+ 引擎日志尾部异常扫描（engine.log 末尾 fatal/Error 关键字）。
 * - 熔断与指数退避：连续失败 → 指数退避（5s→10s→20s→40s→80s 封顶），超过熔断阈值（12 次连续失败）
 *   暂停看门狗并记录（界面提示由 GuideChrome 状态区显示），用户交互或探活成功自动复位。
 * - 开机自启：BOOT_COMPLETED 接收器恢复用户上次同意的运行状态（EngineService.userShutdown 持久化）。
 * - 前台唤醒锁：引擎前台运行期间持有（PARTIAL_WAKE_LOCK，标准档位；获取失败降级尽力模式并记录）。
 * - 授权状态探活：ADB 配对断线时记录（F2.9，桥引导重新配对由桥层返回）。
 */
object WatchdogV2 {

  private const val TAG = "dsh-watchdog"
  const val MAX_CONSEC_FAILURES = 12

  /** half-open 恢复窗（2026-10 修复）：熔断持续该时长后自动降级重试一次。 */
  private const val HALF_OPEN_MS = 5 * 60_000L

  @Volatile
  var consecutiveFailures = 0
    private set

  /** 熔断进入时间（half-open 恢复基线）。 */
  @Volatile
  private var trippedAt = 0L

  /** 引擎日志增量扫描游标（上次已读到的文件长度；rotate/截断时自动重置）。 */
  @Volatile
  private var lastLogOffset = 0L

  /** 指数退避：5s * 2^n，封顶 80s。返回下次探测延迟（ms）。 */
  fun nextDelayMs(): Long {
    val n = consecutiveFailures.coerceAtMost(4)
    return (5_000L shl n).coerceAtMost(80_000L)
  }

  fun recordProbe(healthy: Boolean) {
    consecutiveFailures = if (healthy) 0 else consecutiveFailures + 1
    if (consecutiveFailures >= MAX_CONSEC_FAILURES) trippedAt = System.currentTimeMillis()
  }

  /**
   * 熔断判定。half-open（2026-10 修复）：熔断 5 分钟后自动降级放行一轮探活——
   * 熔断期间 recordProbe 停摆，旧实现 consecutiveFailures 永远 >= 阈值且无人复位，
   * 看门狗永久瘫痪（只能等 MainActivity 用户交互路径 reset）。降级后探活失败会
   * 在 recordProbe 里重新进入熔断（重开 5 分钟窗口），成功则归零恢复正常。
   */
  fun tripped(): Boolean {
    if (consecutiveFailures < MAX_CONSEC_FAILURES) return false
    if (System.currentTimeMillis() - trippedAt > HALF_OPEN_MS) {
      consecutiveFailures = MAX_CONSEC_FAILURES - 6
      trippedAt = System.currentTimeMillis()
      LogCollector.log(TAG, "watchdog half-open: retry after circuit-break window")
      return false
    }
    return true
  }

  fun reset() {
    consecutiveFailures = 0
    trippedAt = 0L
  }

  /** 深度探活：EngineProbe + 插件/权限端点 + 引擎日志尾部异常扫描。 */
  fun deepProbe(context: Context): Boolean {
    val base = EngineProbe.check().optBoolean("running", false)
    if (!base) return false
    // 插件树/桥端点（bridge 插件注册；未注册时 404=false 但引擎健康仍算通过——以 base 为准）
    // 2026-08-23 修复：旧代码 (pluginHealth || true) 恒真 —— 白跑一次 HTTP 且死代码。
    // 桥端点仅用于对时状态采样；日志异常扫描才是探活退出面的信号（插件树近期变化
    // 由 engine.log 的 "plugin tree failed to load" 捕获）。
    val logOk = !engineLogShowsFailure(context)
    // F0.3 事件桥消费（2026-08-24）：引擎任务完成标记 → 系统通知（探活成功才消费，避免引擎
    // 挂死时误弹；消费幂等——读完即清）。
    if (logOk) consumeTaskDoneMarkers(context)
    return base && logOk
  }

  /** 引擎事件桥标记文件（dsh-android-bridge 写入 home/.dsh/.task-done.ndjson；经 context 推导）。 */
  private fun taskMarkerFile(context: Context): java.io.File =
    java.io.File(File(context.filesDir, "home/.dsh"), ".task-done.ndjson")

  /** 消费任务完成标记：逐行解析 → NotifyCenter 通知 → 清空标记（幂等；通知权限未授静默降级）。 */
  private fun consumeTaskDoneMarkers(context: Context) {
    val debugLog = java.io.File(context.filesDir, "notify-debug.log")
    fun dbg(msg: String) {
      try {
        debugLog.appendText(System.currentTimeMillis().toString() + " " + msg + "\n")
        // 滚动截断：>1MB 保留尾部 500 行（2026-10-08 真机报告 B5：诊断日志无上限匀速增长）
        if (debugLog.length() > 1024L * 1024) {
          val lines = debugLog.readLines()
          debugLog.writeText(lines.takeLast(500).joinToString("\n") + "\n")
        }
      } catch (_: Exception) {}
    }
    try {
      val f = taskMarkerFile(context)
      if (!f.exists() || f.length() == 0L) return
      dbg("marker found, len=" + f.length())
      val lines = f.readLines()
      var notified = 0
      for (line in lines) {
        if (line.isBlank()) continue
        dbg("line: " + line)
        try {
          val j = org.json.JSONObject(line)
          val title = j.optString("title").ifBlank { "任务完成" }
          val snippet = j.optString("text").ifBlank { "引擎已完成一轮任务处理" }
          dbg("parsed title=" + title)
          NotifyCenter.notify(context, "task", title, snippet)
          notified++
          dbg("notify returned ok")
        } catch (e: Exception) {
          dbg("notify threw: " + (e.message ?: e.javaClass.simpleName))
        }
      }
      dbg("done notified=" + notified)
      f.writeText("")
    } catch (e: Exception) {
      dbg("consume outer threw: " + (e.message ?: e.javaClass.simpleName))
    }
  }

  /**
   * 引擎日志异常扫描——增量式（2026-10 修复）：只检查上次读取之后**新写入**的内容
   * （上限尾部 64KB），文件变短（rotate/截断）时重置游标。旧实现固定扫尾部 4KB，
   * 历史错误行（UncaughtException / plugin tree failed to load）在日志安静期恒驻
   * 尾部 → 引擎明明健康也恒判失败 → 看门狗循环重启（「用久了老是重启」根因之二）。
   */
  private fun engineLogShowsFailure(context: Context): Boolean {
    return try {
      val f = java.io.File(context.filesDir, "engine.log")
      if (!f.exists()) {
        lastLogOffset = 0L
        return false
      }
      val len = f.length()
      if (len < lastLogOffset) lastLogOffset = 0L // rotate/截断：内容已换代
      val start = maxOf(lastLogOffset, len - 65_536)
      var found = false
      if (len > start) {
        java.io.RandomAccessFile(f, "r").use { raf ->
          raf.seek(start)
          val buf = ByteArray((len - start).coerceAtMost(65_536L).toInt())
          val n = raf.read(buf)
          val tail = String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
          found = tail.contains("UncaughtException") || tail.contains("plugin tree failed to load")
        }
      }
      lastLogOffset = len
      found
    } catch (_: Exception) {
      false
    }
  }

  /** 前台唤醒锁（标准档位；获取失败降级尽力模式并记录审计日志）。 */
  private var wakeLock: PowerManager.WakeLock? = null

  fun acquireWakeLock(context: Context) {
    if (wakeLock?.isHeld == true) return
    try {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:engine").also {
        it.setReferenceCounted(false)
        it.acquire(30 * 60 * 1000L)
      }
      LogCollector.log(TAG, "wake lock acquired (30min standard)")
    } catch (t: Throwable) {
      Log.e(TAG, "wake lock acquire failed (degraded best-effort)", t)
      LogCollector.log(TAG, "wake lock FAILED: ${t.message}")
    }
  }

  /**
   * 唤醒锁续期（2026-08-23 修复：acquire(30min) 是一次性定时释放——引擎常驻超过 30 分钟
   * 后段无锁；releaseWakeLock 从未被调用，服务销毁时也漏释放）。watchdog tick 调用：
   * 持有即重设 30 分钟窗口（setReferenceCounted=false 下 acquire 幂等续窗）。
   */
  fun refreshWakeLock(context: Context) {
    try {
      val held = wakeLock?.isHeld == true
      if (held) {
        wakeLock?.acquire(30 * 60 * 1000L)
      } else {
        acquireWakeLock(context)
      }
    } catch (_: Throwable) {
    }
  }

  fun releaseWakeLock() {
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
    } catch (_: Throwable) {
    }
  }
}

/** 开机自启（零改动原则：仅恢复用户上次同意状态；白名单/厂商跳转引导由设置面承托）。 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val enabled = context.getSharedPreferences("dsh-engine", Context.MODE_PRIVATE).getBoolean("bootAllowsStart", true)
    if (!enabled) {
      LogCollector.log("dsh-watchdog", "boot completed; auto-start disabled by user preference")
      return
    }
    LogCollector.log("dsh-watchdog", "boot completed; starting engine service (user-consented state)")
    try {
      context.startForegroundService(Intent(context, EngineService::class.java))
    } catch (t: Throwable) {
      Log.e("dsh-watchdog", "boot start failed: " + t.message)
    }
  }
}

object BatteryWhitelist {
  /** 引导跳转忽略电池优化设置页（Android 6+）；写入由授权调试档（appops/deviceidle）完成，未授权时仅引导。 */
  fun isIgnoring(context: Context): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return if (Build.VERSION.SDK_INT >= 23) pm.isIgnoringBatteryOptimizations(context.packageName) else true
  }

  private const val ACTION = "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"

  fun requestIntent(context: Context): Intent? {
    return try {
      if (Build.VERSION.SDK_INT >= 23 && !isIgnoring(context)) {
        Intent(ACTION, android.net.Uri.parse("package:" + context.packageName))
      } else null
    } catch (_: Exception) {
      null
    }
  }
}
