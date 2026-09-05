# Seagull DevStudio 代码审计复盘

> 审计对象：私有仓库 `caogenfunan123/seagull-devstudio`（本地 checkout HEAD=835efff）。
> 范围：壳应用 Kotlin 层（MainActivity / EngineManager / EngineService / OverlayService /
> AdbState / AdbKeyboardService / WatchdogV2 / UndoGate / FileIncoming / SnapshotExtractor /
> UpdateManager / EngineProbe / OverlayController）与 7 个 `@dsh-android/*` 插件。
> 方式：逐文件通读 + 静态推理，未做真机构建/回归（无构建环境，不推送）。

## 一、审计结论

- 共发现并修复 **11 处** 问题（功能性 5 + 品牌残留 6），另记录 **5 处待确认观察**。
- 未发现需要大改的架构级缺陷：授权三道门、引擎进程存活语义、桥回调单点、诊断镜像等
  关键面均实现到位，注释与实现高度一致。
- 本轮修复均为高置信、低风险改动（文案 / 死 UI / 明显路径错误 / 注入面收敛），
  静态可核实，不触碰构建链与签名安全面。

## 二、已修复问题清单

### 功能性缺陷（5）

1. **启动等待文案倒计时为负**（`MainActivity.kt`）
   原实现 `waitedSeconds = (budgetEnd - now) / pollStep` 取的是「剩余秒」，文案却写
   `已等待 ${60 - s}s`，90s 预算下显示 `-30s` 等负值。改为按真实流逝秒计算并 15s 步进推送。

2. **悬浮面板「收起」按钮无点击处理**（`OverlayService.kt`）
   header 的「收起」TextView 无 `setOnClickListener`，属死 UI。补 `hidePanel()`。

3. **`tool_install` 落盘走 proot 容器路径必失败**（`dsh-android-tool-installer`）
   `install()` 在 `proot-entry.sh` 存在时经容器执行 `mv`。但 `proot-entry`（`writeProotEntry`
   生成）只 bind `/dev /proc /sys /storage` 与 `$HOME`，未 bind 宿主 `files/usr`；下载落盘在
   宿主 `files/usr/share/...`，容器内 `mv` 找不到源文件，安装必失败（且与注释「plain fs, no
   proot dependency」自相矛盾）。改为统一宿主侧 `renameSync`（`.download` 与目标同目录，不跨
   设备）；顺带清理因此不再使用的 `execFileAsync`/`prootEntry`/`runtimeHome` 死代码。

4. **`root-ops` input_text 注入面**（`dsh-android-root-ops`）
   `input text ${JSON.stringify(text)}` 经 `su -c` 二次 shell 解析，双引号/反斜杠被原样注入。
   改为仅允许可见 ASCII + 拒绝 shell 元字符 + 空格转 `%s`（对齐 manage 的 input text 语义）。

5. **dev-tools 实际用的 proot-entry.sh 缺伪造 /proc 补丁**（`EngineManager.writeProotEntry`）
   仓库存在三个 proot 启动器，行为不一致：`scripts/launch_ubuntu_proot.sh` 会先调
   `setup_fake_sysdata.sh` 伪造 `/proc/stat`/`loadavg`/`uptime`/`version` 并 bind 进容器，
   但 `EngineManager.writeProotEntry()` 生成的 proot-entry.sh（dev-tools 的 `ubuntu_exec`
   实际调用它）既没落伪造文件也没 bind，容器内 `nproc`/`ps`/CMake 的 `-j` 核数检测会读到
   Android 内核格式的 0 核或解析失败。已补齐：新增 `writeFakeSysdata()` 落伪造文件，并在
   proot 命令行 bind 到 `/proc/{stat,loadavg,uptime,version}`，与 launch 脚本对齐。

### 品牌残留（6）

`DeepSeek`/`DeepCode`/`dsh 引擎` 等旧品牌词统一为 Seagull，涉及：
- `MainActivity.kt`（引导页 Idle 文案）
- `EngineService.kt`（通知标题「DeepCode 引擎运行中」→「Seagull 引擎运行中」、渠道名
  「dsh 引擎」→「Seagull 引擎」）
- `AdbKeyboardService.kt`（IME 视图标签）
- `OverlayService.kt`（悬浮球 contentDescription）
- `strings.xml`（`adb_keyboard_label`）
- `dsh-android-manage`（`ui_input` 引导文案「DeepSeek ADB 输入通道」→「Seagull …」）
- `dsh-android-seagull`（persona 缺失时 `console.error` 标记而非静默跳过）

## 三、待确认观察（未改，供用户定夺）

1. **`apk_build_sign` 的 keystore 路径可疑**（`dsh-android-apk-tools`）
   `keystore = runtimePrefix() + '/.dsh/keystore/debug.keystore'` 拼在 `files/usr` 下，仓库中
   无任何生成该 keystore 的逻辑，`apksigner` 会因找不到签名密钥而失败。是否应有内置密钥资产
   或改用 `keytool` 现场生成，需产品确认（涉及签名安全，未擅改）。

2. **`tool_install` 下载无校验**（`dsh-android-tool-installer`）
   `downloadFile` 对 GitHub/Bitbucket 源无 sha256 校验，供应侧完整性无保障。L2 工具（radare2/
   rizin）为 `native` 类型但安装后仅落一个 `.tar.xz/.tar.gz` 文件、未解压，与「可执行」预期不符。
   radare2 源为通用 tar.xz（非 Android 预编译），装了也未必能跑。属 L2 选装项的功能完备性缺口。

3. **`dev-tools` 的 `/bin/bash` 依赖**（`dsh-android-dev-tools`）
   `ubuntu_exec` 硬编码 `/bin/bash [proot-entry]`。在引擎 termux-exec 环境里 `/bin/bash` 依赖
   LD_PRELOAD 重路由，若 preload 缺失（引擎启动已有断言）或 proot-entry 路径异常，会报错。
   当前属「环境就绪前提」而非独立缺陷，但可考虑改 `process.env.SHELL ?? 'bash'` 增加鲁棒性。

4. **NSD 双 discovery 共用单 listener 的并发性**（`AdbState.kt`）
   `discoverServices` 对两个服务类型共用一个 `DiscoveryListener`，`resolveService` 的异步回调
   与 `CountDownLatch(2)` 的计数匹配依赖「每次 onServiceFound 恰好 resolve 一次」。mDNS 抖动
   下存在计数错位可能（早减到 0 提前返回，或停止发现后仍有回调）。当前有 2s 超时兜底，影响
   有限，但属可加固点。

5. **Ubuntu 容器能否真正跑起来，静态审计无法确认**（硬性边界）
   本地 `assets/` 无 `ubuntu-rootfs.tar.xz`/`tools/`/`snapshot.tar.xz`（三类大文件不入库，CI
   从官方 Release 下载），无法核对 rootfs 内容、proot 二进制与工具 jar 是否真实正确；proot 的
   `libtalloc`/`libandroid-shmem` 依赖闭包只在快照构建时才能验证；PRoot 在 Android 上的信号/
   pty/proc 挂载等运行时行为也需真机回归。本轮只把「三个启动器不一致」这一静态可确证项修掉，
   容器整体可用性需真机/模拟器 `ubuntu_exec` 实测后才敢下结论。

## 四、关键实现落点（供后续维护索引）

- 引擎端口单一真源：`EngineProbe`（`ENGINE_PORT=32080` / `ENGINE_URL`）。
- 授权写面唯一出口：`AdbState`（`setAllowSwitch/pairWithCode/revokePair` + 审计），引擎插件
  `dsh-android-bridge` 只读 live SharedPreferences，`/api/android/privilege/status` 只读。
- 引擎进程存活语义：`EngineManager.engineProcessAlive()`（句柄活 + 端口可达兜底）；启动轮询
  90s 预算，进程死才宣判失败走 `maybeAutoUndo`。
- 桥回调单点：`MainActivity:763` 的 `addJavascriptInterface(AndroidBridge(...), "androidBridge")`，
  异步结果经 `window.__dshBridge.onDirectoryPicked(callbackId, path)`。
- 工具资产装配：`EngineManager.extractToolAssets()` 解 `assets/tools/*` 与 `ubuntu-rootfs.tar.xz`
  到 `usr/share` / `home/.dsh/ubuntu-rootfs`（含 `proot-entry.sh`）；幂等以 `bin/bash` 为最硬落点。
