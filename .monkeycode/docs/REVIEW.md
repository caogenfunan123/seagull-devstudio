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

## 五、第二轮全量复盘与修复记录（2026-10-08，提交 d0e4b9c 前）

三路并行复审（Kotlin 壳层 23 文件 / 插件 11 包 / 构建链脚本）共发现 2 项 P0、12 项 P1、
17 项 P2。已修清单（按严重度）：

### P0（必修）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| P0-1 | `EngineManager.kt` | `engineProcess` 是实例字段，而 MainActivity 与 EngineService 各 new 一个 EngineManager——服务侧看门狗的 `engineProcessAlive()` 永远拿不到 Activity 侧 spawn 的引擎，冷启动 20-45s 端口未监听期间误判「进程已死」→ 绕过冷却窗 kill 重启，且正常冷启动即触发 UndoGate 自动回退（用户观感：配置被回滚、引擎起不来） | 字段提升 companion `@Volatile var engineProcess`，全部 7 处引用限定为 `EngineManager.engineProcess`，双实例事实一致 |
| P0-2 | `build-apk-013.ps1:15` | `$pluginDirs` 仅 7 项，漏挂全部 7 个 Seagull 插件（seagull/root-ops/dev-tools/apk-tools/tool-installer/disk-maintainer/backup）——本地 Windows 构建产物静默缺失 Seagull 全部能力，与 CI 路径 `build-apk.mjs` 不对称 | 补齐 7 项 + 新增插件 build/校验段（缺 `lib/index.js` 即现场 `npm run build`，失败即拒打包） |

### P1（已修）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| P1-1 | `MainActivity.kt:693` | `onDestroy` 调 `stopEngine()`：Activity 因配置变更/进程内重建销毁时引擎被杀，且重置 90s 冷却窗 | 删除该调用（引擎保活归 EngineService/shutdownToGuide），注释说明 |
| P1-2 | `EngineManager.stopEngine` | 仅 `destroy()` 无 waitFor——SIGTERM 未退即返回，调用方误以为已停；孤儿进程无兜底 | 补 `waitFor(3s)` + `destroyForcibly` + `waitFor(2s)`，复用提取出的 `killOrphanEngineProcesses()` |
| P1-3 | `tool-installer/src/index.js:154` | 解压走 `tar -xzf/-xJf`——快照 tar.real 的压缩器子进程 exec 恒失败（坑 49），L2 工具（radare2/rizin）在线安装整体失效 | 两步解压：`.tar.gz` 走 node:zlib 流式 gunzip、`.tar.xz` 走独立 `xz -dc`，统一 `tar -xf` 裸包（对齐 backup 插件修复模式） |
| P1-4 | `manage/src/ui-tree.ts:163` | `byOrig` 只按原始 XML 路径键注册，而 `findActionableAncestor` 收到的是重编号 `n{i}` → 恒 miss →「目标不可点时回退可点击祖先」100% 失效 | 同一 entry 双键注册（原路径 + 重编号别名），父链仍按 parentOrig 走 |
| P1-5 | `tool-installer downloadFile` | 无超时（镜像挂起时任务永驻 downloading）+ WriteStream 无 error 监听（磁盘满时 Promise 永不 settle）+ 重定向无上限 | 120s 超时、`file.on('error')` 统一 fail 清残、最多 5 次重定向 |

### P2（已修）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| P2-1 | `FileIncoming.kt` | `File.delete()` 对非空目录恒 false——TTL sweep 与 cleanupTmp 遇目录静默残留 | 新增 `deleteRecursively`（对齐 deleteForOverwrite 语义：软链不跟随、目录逆序递归） |
| P2-2 | `backup/src/index.js:145` | `preRestoreSnapshot` 的 `_restored-from.json` 写入时 `dir/stamp` 目录可能不存在（scope 全 skip/失败时循环不建）→ ENOENT 把恢复流程抛死 | 写入前 `mkdirSync(join(dir, stamp), { recursive: true })` 兜底 |
| P2-3 | `bridge AdbAuthSection.tsx:281` | 旧壳 boolean 纪元兼容方向写反：`j===null` 时不分 `raw===true/false` 一律报失败——配对着也误报 | `raw===true` 按旧语义成功提示刷新确认；`raw===false` 才报失败 |
| P2-4 | `file-open/src/index.ts:352` | `clean` 端点是破坏性操作但不校验 method——任何 GET（页面预取/扫描器）都会清空临时工作区 | 仅放行 POST，其余 405 |
| P2-5 | `file-open/src/index.ts:339` | claim 端 `rmSync(target)` 无 recursive——条目是目录时静默失败，下次 claim 重复弹文件 | 补 `{ recursive: true, force: true }` |
| P2-6 | `dev-tools/src/index.js:81` | `await stat(bash)` 在 access 的 try 外——access 与 stat 之间竞态/软链断裂会抛未捕获异常崩掉工具 | 合并进同一 try，如实转 not-present 语义 |
| P2-7 | `linux-env/src/index.ts:86` | `profilePatch` 字段 readText 缺失返回 undefined，而 output.schema 声明 string——undefined 成员被引擎 lossless 拒收（坑 34 同类） | `?? ''` 兜底 |
| P2-8 | `disk-maintainer/src/index.js` | 注释声称 lstat 语义实际用 statSync（跟随软链）——目录环重复计数、软链目标重复统计 | 全部 6 处改 `lstatSync` |
| P2-9 | `NotifyCenter.kt:44` | `lastAt/lastCount` 普通 map，notify 从 WatchdogV2 探活线程与 UI 线程双路调用——并发写有 CME/脏读风险 | 改 `ConcurrentHashMap` |
| P2-10 | `OverlayService.kt:84` | probe 轮询 Runnable 只由 hidePanel 清理，onDestroy 路径（通知栏停止/系统回收）漏停——服务已死而 10s 轮询不亡 | onDestroy 补 removeCallbacks + `removeCallbacksAndMessages(null)` |

### 未修（记录在案，按发布节奏处理）

- root-ops 10 个工具无 `gateFor` 会话门控（仅 system-prompt 提示按档位条件注入；执行面任何档位可调 `su -c`）——涉及授权模型调整，需产品决策后与 AdbState 三道门统一。
- UpdateManager 下载限流为事后校验、swap 前不杀引擎、pending 标记写入晚——0.13.1 既有行为，真机回归确认无实际事故后再说。
- AdbState.ensureAdbServer 在 synchronized 内 `readText` 先于 `waitFor`（线程阻塞风险）——冷启动路径已在 F2 修复中缓解，改动需真机验证。
- 插件层 P2 余项（uiCache 单槽跨会话、ui-tree 闭标签误判、tarRestore 成员类型不校验、gunzipSync 全内存、probeAllowlist denylist 语义、审计滚动非原子等）——均有明确修法，不影响主链路正确性。

## 六、真机测试结论（2026-10-08，v0.13.4-seagull apk-37714477450）

**六项验证全部通过，0 个 P0/P1 回归。** 设备：aarch64 真机 + KernelSU root 免弹窗；包体 sha256 与 release 完全一致（252,356,699B）；snapshot node ELF = EM_AARCH64；引擎探活 32080 HTTP 200/3ms；冷启 `am start` → 引擎就绪 3s，force-stop 后 EngineService ~39s 自愈。

| 项 | 结论 | 证据 |
|---|---|---|
| 冷启动 ×3 不回滚（P0 坑 56 修复） | PASS | 三轮 settings.yaml sha256 均等于基线，engine.log 每轮干净，logcat 无 auto-undo |
| radare2 在线安装（P1-3 坑 49 修复） | PASS | `tool_install --force` ok → radare2 5.9.8，bin 全家桶在位（开机 probe EACCES 系误报） |
| 不可点节点祖先回退（P1-4 坑 57 修复） | PASS | root 通道点系统设置不可点摘要成功跳页 |
| env_recipe 导出（P2-7） | PASS | 零序列化错误，profilePatch 数据源在场 |
| backup 全流程（P2-2） | PASS | pre-restore 快照落盘、哈希一致、无 ENOENT |
| 分享 + 清理（P2-1） | PASS | 文件入 incoming → 自动建 session-1 → clean removed:1 |
| 10s probe 指纹（P2-10） | PASS（未执行停悬浮球动作，指纹级证据） | 60s logcat 324 次连接节律为 3s 轮询，9.5-10.5s 零命中 |

报告另抓 1 个代码级待修项（safeResolveInside 路径形态敏感，壳侧 `/data/data` 形态 + ws `/data/user/0` 形态被早期字符串判定误拒 → 分享入队 100% 失败）——**已修**，见坑 59；另 1 条手册备注（设备端 `tar -xf` 踩 `xz: Cannot exec`，改 `xz -dc | tar -x`）已同步 §3.2 步 4 与坑 49。

