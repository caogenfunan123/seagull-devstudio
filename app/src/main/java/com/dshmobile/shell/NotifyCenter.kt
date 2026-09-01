package com.dsharnessmobile.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * 项目进度通知中心（0.13.0 F0.3）：引擎事件桥 → 系统通知栏推送。
 * - 三类渠道：task（任务完成）/ todo（待办更新）/ auth（授权请求，明示含描述）
 * - 按类开关（默认开；授权请求类明示内容敏感性）；通知权限未授予时静默降级（界面内提示由调用方负责）
 * - 高频更新节流合并：同类短窗口（2s）内多次更新合并为一条摘要（更新文本 + 计数）
 * - 点击返回：带 target 摘录回 MainActivity（会话/设置定位由引擎侧路由，本层只回应用）
 * - 不涉及任何授权档位（常规通知权限，PRD F0.3-5）
 */
object NotifyCenter {

  private const val PREFS = "dsh-notify"
  private const val KEY_TASK = "cat.task"
  private const val KEY_TODO = "cat.todo"
  private const val KEY_AUTH = "cat.auth"
  private const val THROTTLE_MS = 2_000L

  private val channelIds = mapOf(
    "task" to "dsh-task",
    "todo" to "dsh-todo",
    "auth" to "dsh-auth",
  )

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun enabled(context: Context, category: String): Boolean =
    prefs(context).getBoolean("cat." + category, true)

  fun setEnabled(context: Context, category: String, value: Boolean) {
    prefs(context).edit().putBoolean("cat." + category, value).apply()
  }

  private val lastAt = mutableMapOf<String, Long>()
  private val lastCount = mutableMapOf<String, Int>()

  fun notify(context: Context, category: String, title: String, text: String, target: String? = null) {
    val app = context.applicationContext
    if (!enabled(app, category)) {
      LogCollector.log("dsh-notify", "notify skipped (category disabled): $category")
      return
    }
    if (Build.VERSION.SDK_INT >= 33 &&
      app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
      android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      LogCollector.log("dsh-notify", "notify skipped (POST_NOTIFICATIONS not granted): $category")
      return // 未授予：静默降级（调用方界面内提示；不崩溃）
    }
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channelId = channelIds[category] ?: channelIds["task"]!!
    if (Build.VERSION.SDK_INT >= 26) {
      val label = when (category) {
        "auth" -> "需要授权"
        "todo" -> "待办更新"
        else -> "任务完成"
      }
      val importance = if (category == "auth") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
      manager.createNotificationChannel(NotificationChannel(channelId, label, importance))
    }
    // 节流合并：同渠道 2s 窗口内合并（摘要 + 计数）
    val now = System.currentTimeMillis()
    val count = if (now - (lastAt[channelId] ?: 0L) < THROTTLE_MS) (lastCount[channelId] ?: 0) + 1 else 1
    lastAt[channelId] = now
    lastCount[channelId] = count
    val body = if (count > 1) "$text（已合并 $count 条更新）" else text

    val intent = Intent(app, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      target?.let { putExtra("dsh.notify.target", it) }
    }
    val pending = PendingIntent.getActivity(
      app, channelId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notifId = ("dsh-" + category).hashCode() and 0x7fffffff
    LogCollector.log("dsh-notify", "notify: $category / $notifId / $title")
    android.util.Log.e("dsh-notify", "notify called: $category / $notifId / $title / perm=" +
      (Build.VERSION.SDK_INT < 33 ||
        app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED))
    manager.notify(
      notifId,
      NotificationCompat.Builder(app, channelId)
        .setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(title)
        .setContentText(body)
        .setContentIntent(pending)
        .setAutoCancel(true)
        .build(),
    )
  }
}
