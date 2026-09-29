# Seagull DevStudio 改造方案

> 基于对**当前运行实例**（DSH 0.13.x @ `:32080`）与 **DSHA**（DSH 0.1.7-rc.2 @ `:3080`）的实测对比。
> 所有结论均来自真机文件与运行时检查，非推测。
> 采集时间：2026-09-29 · 采集实例：`com.dsharnessmobile.shell` 0.13.2-seagull (versionCode 28)

---

## 0. 结论先行

三个原始诉求的实测根因：

| # | 诉求 | 真实根因 | 是否需要引入 DSHA |
|---|---|---|---|
| 1 | 塞太多会卡死、引擎起不来 | **磁盘热点不在 session**（session 仅 9.4MB）。真热点是 `workspaces/` 747MB + `fetched/` 46MB 无回收 | 否 |
| 2 | 每次都要 AI 修工具链 | **工具都装了，但是坏的**：jadx 报 tmpdir 不存在、radare2 报 `libr_cons.so` 找不到。根因是环境变量（`TMPDIR` / `LD_LIBRARY_PATH`）没配对，且**没有启动自检** | 否 |
| 3 | 参考 DSHA 的启动页/插件页/设置页/终端页 | DSHA 的优势在**宿主基础设施**（磁盘维护、备份、工具自愈），不在提示词 | 部分：只借基础设施层 |

**核心判断：DSHA 的提示词比海鸥差（它是通用 coding agent 人设），但 DSHA 的宿主工程化做得更细。
正确做法是「保留海鸥全部提示词与工具面，只补宿主自愈能力」，而不是整体换皮。**

---

## 1. 当前实例实测基线

### 1.1 运行时身份

```
引擎进程：/system/bin/linker64 .../usr/bin/node --expose-internals \
         .../@deepseek-ai/dsh/lib/bin.js web --port 32080 --no-open
DSH_HOME：/data/user/0/com.dsharnessmobile.shell/files/home/.dsh
注入环境：DSH_PICK_TOKEN / DSH_ADB_FULLACCESS=1 / DSH_ADB_ALLOW=0
```

运行时是 **operit loader + 自建 snapshot**（`base-dsh.tar.xz`），
**不是** DSHA 的 proot + `offline-rootfs.bin`。这条差异决定了 DSHA 的
`ProotBootstrap` / `HarnessController` **不能直接复用**。

### 1.2 磁盘占用实测（总计 6.1GB）

```
filesDir/                          6.1G
├── home/                          4.9G
│   └── .dsh/                      3.7G
│       ├── ubuntu-rootfs/         2.7G   ← Ubuntu 24.04 容器，运行时必需，不可清
│       ├── workspaces/            747M   ← 真热点
│       │   ├── zcode_out/         394M
│       │   ├── ky01l-backup/      211M
│       │   ├── DSHA/               96M
│       │   └── NEOWAY-N58-firmware/ 37M
│       ├── profiles/              142M
│       │   └── web/node_modules/  141M   ← 插件代码，DSHA 侧有维护策略
│       ├── fetched/                46M   ← 临时下载的 APK/截图，无 TTL
│       ├── .node-compile-cache/    14M
│       ├── sessions/              9.4M   ← **不是问题源**
│       ├── skills/                7.4M
│       ├── tmp/                   4.4M
│       └── undo-snapshots/        1.2M
└── usr/                           1.3G
```

**关键否证：session 目录只有 9.4MB。**「塞太多东西卡死」不是会话堆积造成的。
真正的膨胀来自用户工作区（git 仓库 + node_modules + 固件包）和永不回收的 `fetched/`。

### 1.3 工具链实测（问题 2 的真根因）

| 工具 | 声明 | 实际落点 | 实测结果 |
|---|---|---|---|
| java | — | `usr/bin/java` | ✅ 可用 |
| apktool 2.9.3 | L1 built-in | `usr/share/apktool/apktool.jar` | ✅ `2.9.3` |
| jadx 1.5.0 | L1 online | `usr/share/jadx/` | ❌ **报错** |
| radare2 | L2 online | `usr/share/radare2/` | ❌ **报错** |
| python3 | — | `ubuntu-rootfs/usr/bin/python3.12` | ✅（容器内） |
| node | — | `ubuntu-rootfs/usr/bin/node` | ✅（容器内） |

**jadx 报错全文：**
```
Exception in thread "main" java.lang.ExceptionInInitializerError
Caused by: java.nio.file.NoSuchFileException:
  /data/data/com.termux/files/usr/tmp/jadx-instance-4653745290775436854
```
JVM 的 `java.io.tmpdir` 指向 **`/data/data/com.termux/...`**（Termux 的包名），
而本 fork 的包名是 `com.dsharnessmobile.shell`，该路径不存在。

**radare2 报错全文：**
```
CANNOT LINK EXECUTABLE "linker64": library "libr_cons.so" not found
```
库文件**确实在** `usr/share/radare2/lib/libr_cons.so`，
但 `dsh-shell-termux` 只设了 `LD_LIBRARY_PATH=${prefix}/lib`，没包含这个子目录。

> **所以「每次都要 AI 修工具链」的真相是：工具文件在，但运行环境没配对，
> 且没有任何启动自检去发现并修复它。** 每次都是 AI 现场发现 → 现场修。
> 这是宿主自愈能力的缺失，不是工具链缺失。

### 1.4 提示词链路（问题 3 的边界）

海鸥 persona 当前**不经** DSH 的 agent preset 系统：

```
settings.yaml           → 无 agent-presets 字段
profiles/web/cordis.yml → 空根列表 []
profiles/web/cordis.patch.yml → 17 行 insert，挂载 @dsh-android/* 插件
        ↓
@dsh-android/dsh-android-seagull
  └─ ctx.on('system-prompt/assemble', …)
       └─ assembly.sections.push({ name: 'seagull', text: <persona.md 259行> })
```

对比 DSH 的两套 persona 机制：

| 机制 | 行为 | 海鸥用了吗 |
|---|---|---|
| `dsh-persona` 插件（agent preset 层） | 注册 `name="deployment:persona"`，**替换** | 没用 |
| `system-prompt/assemble` 事件 | push 新 section，**追加** | ✅ 在用 |

**含义：海鸥 persona 是追加在 DSH 默认 persona 之后的，两段都在。**
这不影响可用性（海鸥段在后面，`{{model}}`/`{{cwd}}` 变量仍由 DSH 提供），
但如果将来要切到 DSHA 那种「预设即身份」的模型，需要改成 `dsh-persona` 替换。

### 1.5 已具备的能力（不需要重做）

| 能力 | 实现 | 状态 |
|---|---|---|
| 插件市场 | `dshmarketplace-plugin` | ✅ 工作（含风险标记 + 安装审批） |
| 崩溃回退 | `dsh-undo-savepoint`（含 safe mode） | ✅ 工作 |
| 工具安装器 | `dsh-android-tool-installer`（三级注册表 + sha256 + 镜像链） | ⚠️ 能用但**无首启自检** |
| 工具链面板 | `dsh-android-linux-env` | ✅ 工作 |
| ADB/root 授权 | `dsh-android-bridge` + `AdbState.kt` | ✅ 工作（三门授权） |
| 终端 | `ConsoleActivity` + `ConsoleSession` | ⚠️ 非 PTY，单会话 |
| 日志轮转 | `LogCollector`（5MB 轮转） | ✅ 工作 |

---

## 2. 与 DSHA 的差异（只列有决策价值的部分）

### 2.1 不可复用

| DSHA 模块 | 原因 |
|---|---|
| `ProotBootstrap` | 依赖 proot + `filesDir/linux/ubuntu/` 布局 |
| `HarnessController` | 建立在 ProotBootstrap 上 |
| `RecoveryRuntime` | 同上，且自带独立 runtimeId 锁 |
| `agent-preset-patch.json` / `client-combo-patch.json` | 直接改 DSH 内置 JS 与版本号（rc.2），与本 fork 的 0.13.x 快照不匹配 |
| `persona-compat-patch.json` | 专门为 DSHA 自己的 `prefix`→`text` 兼容，本 fork 用 `assemble` 钩子不需要 |

### 2.2 可复用（低风险）

DSHA `app/src/main/java/.../util/` 下 **118 个类零 Android 依赖**，有 JVM 单测覆盖。
真正值得搬的只有几件与 Android 无关的纯逻辑：

| 类 | 用途 | 是否需要 |
|---|---|---|
| `BackupScope` | 备份范围的唯一定义（全量/对话/设置/插件） | 做备份时需要 |
| `ShellQuote` | POSIX 单引号转义（安全边界） | 已有等价物 |
| `WebProcSel` | 「哪些进程算 Web 进程」唯一定义 | 引擎启停加固时需要 |
| `Fmt` / `SensitiveData` / `Query` | 格式化 / 脱敏 / 参数 | 按需 |
| `MaintenanceGate` / `MaintenanceTransaction` | 维护互斥与事务 | 做磁盘维护时需要 |

### 2.3 DSHA 真正强于本 fork 的两点

1. **维护协调器**（`MaintenanceCoordinator`）：停止屏障 + 数据任务锁 + 磁盘事务三件套，
   保证「清理磁盘时引擎不会同时写坏数据」。本 fork 的 `UndoGate` 是单点回撤，没有互斥。
2. **工具自愈**：DSHA 有 `BasicToolsInstaller`（第 2 步修复）+ `InstallProbe`（逐步探测），
   探测失败才修。本 fork 的 `tool-installer` 只有「用户喊装才装」，没有「自检发现缺就修」。

---

## 3. 改造方案

### P0 — 工具链自愈（解决问题 2，改动最小、收益最直接）

**根因**：环境变量没配对 + 无自检。

**做法**（两处，都在宿主侧）：

1. `dsh-shell-termux` 补 `extraPath` 与 `LD_LIBRARY_PATH` 条目：
   ```
   extraPath:        [<prefix>/share/jadx/bin, <prefix>/share/radare2/bin]
   LD_LIBRARY_PATH:  <prefix>/lib : <prefix>/share/radare2/lib
   TMPDIR/TMP/TEMP:  <home>/.dsh/tmp
   ```
   这一步直接把 jadx / radare2 从「报错」变「可用」。

2. `dsh-android-tool-installer` 增加 `apply(ctx)` 里的**首启自检**：
   挂载后跑一次 `probe()`，对注册表里每个工具验证「落点存在 + 可执行 --version 成功」，
   失败则修 PATH 环境并重试；仍失败才标记为待装（交给 `tool_install`）。
   修复结果写 `<filesDir>/.toolchain-probe.json`，避免每次启动重跑。

**验收**：`ubuntu_exec` 与 `shell-termux` 两条通道下，
`jadx --version` / `apktool --version` / `radare2 --version` / `java -version` 全部返回版本号且退出码 0。

**不做**：不引入 DSHA 的 `InstallPipeline` / `IsolatedInstallProcess`（那是 proot 专属，
且本 fork 已有能用的下载+校验+解压链路）。

### P1 — 磁盘维护（解决问题 1）

**根因**：无回收策略。真热点是 workspaces 与 fetched。

**做法**：新增 Cordis 插件 `@dsh-android/dsh-android-disk-maintainer`，在
`dsh-undo-savepoint` 之后挂载（复用它已有的 config 快照能力做前置保护）。

| 目标 | 策略 | 保护 |
|---|---|---|
| `fetched/` | 超过 14 天或总量 > 200MB → 删最旧 | 删前记入 `.dsh/log/maintain.log` |
| `tmp/` | 超过 3 天 → 清空 | 同上 |
| `sessions/` | 超过 90 天 → 删（保留最近 200 个） | 同上 |
| `workspaces/` | **不自动删**（用户数据），但产出报告：各子目录大小 TOP20 + 建议 | 仅报告 |
| `.node-compile-cache/` | 超过 500MB → 清（可重建） | 同上 |
| `profiles/*/node_modules/` | 报告「已装但 cordis.patch.yml 未引用」的孤立包 | 仅报告 |

**关键设计：不碰 workspaces。** 那是用户工作区，自动删等于丢数据。
只做报告让用户自己决定。DSHA 在这点上同样是「保留原件，只清可再生缓存」。

**触发时机**：挂载后延迟 30s 跑一次（避开引擎启动高峰），之后每 6h 一次。
`ctx.effect()` 持有定时器，随插件卸载清理。

**与 DSHA 的关系**：这里借 DSHA 的**策略**（可再生 vs 不可再生二分），
不借它的**实现**（它的 `EnvironmentMaintenance` 依赖 proot 布局与 `MaintenanceCoordinator`）。

### P2 — 备份恢复（对齐 DSHA 的用户价值）

**根因**：本 fork 只有「配置/插件代码快照」（undo-savepoint），
没有「会话 + 配置 + 插件」的整体导出/恢复。用户换机或误删只能干瞪眼。

**做法**：新增 `@dsh-android/dsh-android-backup`，端口复用 DSHA 的设计：

- 范围定义直接采用 DSHA `BackupScope` 的四档（全量 / 只对话 / 只设置 / 只插件）
- 归档为 `tar.gz`，文件名前缀区分档位（DSHA 踩过的坑：老版本会把「只对话」包当全量恢复）
- 导出落 `Documents/dshdata/exports/`，通过 SAF 让用户选目标
- 恢复走 undo-savepoint 的 pre-restore 快照，失败可退

**不做**：DSHA 的 AES-GCM 主机密钥加密（那是它宿主 v5 方案的一部分，
本 fork 的凭据本来就在 `files/`，没有跨设备密钥交换需求）。
改用口令加密（用户设置备份密码，DSHA 也有这层）。

### P3 — 终端与页面结构（问题 3 的实际内容）

**根因**：用户要的「启动页/插件页/设置页/终端页」在原生层，而本 fork 的
主界面是一个 WebView 套 DSH 自带前端。`ConsoleActivity` 是独立 Activity，
不在主界面导航里。

**做法（先做最小可见的一步）**：

1. 把 `ConsoleActivity` 从「独立 Activity」改为**主界面底部 Tab 的第二页**
   （复用同一个 WebView，切换时 reload 对应 URL，不新建 Activity）。
2. Tab 条加在 `MainActivity` 的 `FrameLayout` 底部，高度 56dp，
   WebView 相应收缩 —— 与 DSHA 的 `BottomNavigationView` 观感一致但更轻。
3. 「启动页」=现有的 `GuideChrome`（已经是运行时状态/解压进度/崩溃/日志的统一入口，
   不需要重写）。「插件页」和「设置页」**已经存在**，在 DSH 自带前端的设置面板里
   （`dsh-android-linux-env` 提供工具链/共享目录/镜像；`dshmarketplace` 提供市场）。

> **不重写 UI。** DSHA 的 Fragment 体系依赖 proot 启动页状态机，
> 本 fork 的 `GuideChrome` 已经覆盖同等职责。抄过来是两套状态机并存，纯负债。

### P4 — Persona 机制迁移（0.13.3 实测定案：无需改动）

源码级实锤（`@deepseek-ai/dsh-system-prompt/lib/index.js`）：

1. `SystemPrompt.Config.persona` 默认 `z.string().default("")` —— 全局 persona section
   以空文本注册；`renderPrompt` 明确 **"drop empty sections"**（空 section 不进模型 prompt）。
2. 因此当前 `dsh-android-seagull` 的 `assemble` 追加 section 就是模型看到的**唯一 persona**
   ——「追加」在默认 persona 为空的现实下等价于「替换」。原方案的收敛目标已天然达成。
3. 备选路径均被源码否决：
   - `dsh-persona` row 是 scope-only（源码注释明示 *"mounted globally it collides with the
     registry's own registration and fails loud"*），profile patch 挂它会 fail loud；
   - `systemPrompt.Config.persona` 是 host service config，profile patch 无法触及
     （patch config 覆盖只对插件 row 生效）。

**结论：保持现状（assemble 追加），零代码改动，零风险。**

---

## 4. 执行顺序与依赖

```
P0 工具链自愈      ← 独立，改 2 个文件，1 次重启验证
      │
P1 磁盘维护        ← 独立，新插件，依赖 undo-savepoint 已挂载（已满足）
      │
P2 备份恢复        ← 依赖 P1 的维护协调思想，但不强制依赖其代码
      │
P3 页面结构        ← 独立，改 MainActivity 布局
      │
P4 persona 收敛    ← 依赖 P0-P3 全部稳定后
```

**P0 和 P1 可以并行**（改的文件无重叠）。
P3 建议在 P0/P1 验证通过后再动，因为它是唯一改主界面的。

---

## 5. 风险与回退

| 阶段 | 风险 | 回退方式 |
|---|---|---|
| P0 | 补 `LD_LIBRARY_PATH` 可能与已有 `extraPath` 冲突导致别的库解析错 | 全部改动在 `cordis.patch.yml` 一处，undo-savepoint 一次回退；快照点自动记录 |
| P1 | 误删 workspaces | **设计上不删 workspaces**，只报告。若仍出问题，删 `fetched/`/`tmp/` 是可逆的（重新下载即可） |
| P2 | 恢复覆盖现有数据 | 强制走 undo-savepoint 的 pre-restore 快照；恢复前校验归档完整性 |
| P3 | WebView 复用导致状态串台 | 保留 `ConsoleActivity` 不删，作为「独立打开终端」入口；Tab 故障时可退回 |
| P4 | persona 丢失 | 保留 `assemble` 钩子作为降级路径，两套并存时后者优先级待验证 |

**统一回退手段**：`dsh-undo-savepoint` 已覆盖 config 文件与插件代码树
（`undo_list` / `undo_diff` / `undo_restore`），改 cordis.patch.yml 会被自动快照。

---

## 6. 明确不做的事

| 不做 | 理由 |
|---|---|
| 引入 DSHA 的 proot runtime | 与 operit loader + 自建 snapshot 冲突，是重写不是增强 |
| 抄 DSHA 的 Fragment UI 体系 | 两套启动状态机并存，纯负债；本 fork 的 GuideChrome 已覆盖 |
| 改 DSH 内置 JS（`*_patch.json`） | 绑死 rc.2 版本号，本 fork 跑 0.13.x，升级即碎 |
| 换掉海鸥 persona | 用户明确要求保留 |
| 自动删 workspaces | 用户数据，自动删等于丢数据 |
| 引入 DSHA 的宿主 v5 加密备份 | 本 fork 无跨设备密钥交换需求，口令加密够用 |

---

## 7. 数据来源

本文所有数字与报错均来自本机实测：

```bash
# 磁盘
du -sh files/home/.dsh/*/ | sort -rh
# 工具链
usr/share/jadx/bin/jadx --version          # → ExceptionInInitializerError
usr/share/radare2/bin/radare2 --version    # → libr_cons.so not found
java -jar usr/share/apktool/apktool.jar --version   # → 2.9.3
# 提示词链路
cat files/home/.dsh/profiles/web/cordis.patch.yml
cat files/home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-seagull/lib/index.js
cat files/home/.dsh/settings.yaml          # → 无 agent-presets
# 运行时
cat /proc/$(pgrep -f bin.js | head -1)/cmdline
```

DSHA 对照：`workspaces/incoming/DSHA/`（已 clone，含 `app/src/main/java/**` 42,669 行）
