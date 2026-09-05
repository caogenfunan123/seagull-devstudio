# 模块：app（Android 壳层）

Kotlin 壳 = 平台权能与桥的唯一宿主。目录 `app/src/main/java/com/dshmobile/shell/`。

## 职责

- 快照解压与指纹（首装/升级全量重解压）。
- 引擎进程生命周期（spawn node bin.js web :32080、direct-exec→linker64 回退、孤儿清理）。
- WebView 引擎 UI 承载 + `window.androidBridge` JS 桥。
- 前台服务/看门狗/崩溃自动回退（UndoGate）。
- 授权（AdbState：All Files Access + 开关 + adb pair + 常驻 adb server）。
- 通知（task-done 标记消费 + NotifyCenter）、悬浮球（OverlayService）、ADBKeyboard IME、内置控制台、日志/审计/诊断、共享导出 Documents/dshdata。

## 关键文件与入口

| 文件 | 作用 | 关键点 |
|---|---|---|
| MainActivity.kt | 主界面/桥接线/意图处理 | onResume 幂等 startEngineService；启动串行锁；maybeProcessIncoming（VIEW/SEND→文件直达）；导出 dshdata；迁移/坏键修复 |
| EngineManager.kt | 引擎总管 | snapshotFresh/refreshSnapshot（备份→解压→还原）；extractToolAssets（tools+rootfs，幂等）；shellEnv()（LD_PRELOAD/OPENSSL_CONF/密钥/env）；startEngine（并发锁 + linker64 回退 + 90s 冷却窗）；extractTarAsset（zip-slip 防护） |
| EngineService.kt | 前台服务 | watchdog 5s 探活挂载点 |
| WatchdogV2.kt | 看门狗 v2 | 连续失败熔断→UndoGate；consumeTaskDoneMarkers→NotifyCenter；boot 恢复同意态；.BootReceiver 内部定义 |
| UndoGate.kt | 崩溃自动回退 | 急救 CLI restore-last-good（OPENSSL_CONF 注入必需）；幂等标记 |
| AdbState.kt | 授权真值源 + 真实 adb 通道 | pairWithCode（码只进 argv）/revokePair/discoverPorts（属性直读→NSD→手动）/ensureAdbServer（常驻 + devices 往返就绪）/spawnAdb（Permission denied→linker64）；prefs 键 allowSwitch/paired/pairPort/connectPort/connected/fullAccess |
| AndroidBridge.kt | JS 桥 v1 | setAdbPair(3 参 JSON 结果)/getAdbState/adbShell/exportConfig/importConfig/pickToken/openNativePath（FileProvider 白名单）/requestAllFilesAccess 等 |
| SnapshotExtractor.kt | tar 解压 | x-zip→filesDir；symlink/exec 位戳印；zip-slip 防护 |
| FileIncoming.kt | F5 文件直达 | copyIn 200MB 有界拷贝；sanitizeName/uniqueName；tmpWorkspace=home/.dsh/workspaces/incoming；TTL 7 天清扫 |
| UpdateManager.kt | 在线快照更新（第一版） | usr→usr-old 两步切换 |
| EngineProbe.kt | 常量/探活 | ENGINE_PORT=32080 / ENGINE_URL 单点（fork 迁移唯一改点） |
| ConsoleActivity/ConsoleSession | 内置终端 | 环境与引擎一致 |
| LogCollector.kt | 调试日志 | 日文件轮转 |
| OverlayService.kt / OverlayController.kt | 悬浮球实时面板 | TYPE_APPLICATION_OVERLAY；拖拽贴边（20dp 容差）；面板跟随球；引擎页避让帧（emitFrame/replayFrame）；停止 RPC；live 流 FileObserver |
| AdbKeyboardService.kt / Receiver | ADBKeyboard IME | ADB_INPUT_TEXT/CLEAR 广播→commitText；实例活跃才提交 |
| ShizukuSupport.kt | Shizuku 反射探活 | 仅示例（真实通道走 adb 二进制/root） |

## 资源与清单

- `res/values/strings.xml`：`app_name=Seagull DevStudio`、`ds_brand_subtitle=Ubuntu ARM64 开发者运行时`。
- `AndroidManifest.xml`：前台服务、OverlayService、AdbKeyboardService、.BootReceiver（WatchdogV2 内部）、SAF/存储/网络/通知权限声明。
- `app/build.gradle.kts`：minSdk 26 / targetSdk 34 / compileSdk 36；abiFilters arm64-v8a；versionName 0.13.2-seagull / versionCode 28；签名 keystore（CI 用 keystore/debug.keystore 固定）。

## 对外契约

见 [接口文档](../INTERFACES.md)。壳对外暴露面收敛为：`window.androidBridge`（页面）、HTTP 32080（引擎）、前台服务通知、SAF FileProvider 导出、广播（IME/通知标记）。

## 依赖关系

壳依赖快照内二进制（node/bash/adb/proot/java）+ assets 工具资产；引擎依赖壳注入 env；插件页面依赖桥。反向：壳不内嵌任何引擎逻辑。
