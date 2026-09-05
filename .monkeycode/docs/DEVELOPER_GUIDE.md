# 开发者指南

## 项目目的

Seagull DevStudio 是 DeepSeek Harness 的安卓壳 fork（海鸥版）：一个 APK 内嵌 Termux 运行时 + dsh 引擎 + cordis 插件 + Ubuntu PRoot 开发者容器，在手机上提供带设备管理能力的移动开发环境。

**核心职责**:
- 自包含运行时：解压即跑的 Termux rootfs 快照，引擎监听 `127.0.0.1:32080`
- 平台权能与桥：前台服务/看门狗/崩溃回退、WebView UI、SAF 文件桥、ADB 真实通道、KernelSU root 通道、通知、悬浮球、ADBKeyboard IME
- 内置工具集：apktool/jadx/radare2/rizin + Ubuntu 24.04 容器（proot），供 agent 反编译/构建/调测 APK
- 构建链自包含：快照从源重建、云端 CI 从上游直连下载底座与官方资产

**相关系统**:
- 上游 `kelai141/dsh-mobile-apk`（0.13.2-preview 基线；底座/官方快照来源）
- 上游 `deepseek-ai/deepseek-harness`（快照内 dsh 引擎，只读）
- 兄弟插件：`dsh-shell-termux`/`dsh-client-ui-responsive`/`dsh-host-web-compat`（嵌本仓）

## 环境搭建

### 前置条件
- JDK 17；Android SDK（compileSdk 36）；Gradle 8.11.1（wrapper 提供）
- Node.js（构建脚本/插件构建；前端 tsdown 要求 node ^22.18 || >=24.11）
- Python 3（注入/门禁脚本；脚本以 `python` 调，Debian 系需 `python-is-python3`）
- Linux/WSL 环境跑快照构建（Termux 源装配需 Linux 语义）
- git-lfs（本地拉取 base/ 底座用，若对象未随 fork 上传则需上游可达）

### 快速开始（拉到代码后第一件事）

```bash
# 仓库已是完整项目（本 fork 无 submodule）
git status        # 确认在 main、工作树干净

# 检查大资产就位情况（快照/rootfs/工具为构建产物或 LFS，见下）
ls -la app/src/main/assets/   # 构建前会由 CI/脚本填充

# 构建 Seagull 纯 JS 插件到 lib/
node scripts/build-plugin.mjs seagull
node scripts/build-plugin.mjs root-ops
node scripts/build-plugin.mjs dev-tools
node scripts/build-plugin.mjs apk-tools
node scripts/build-plugin.mjs tool-installer

# 语法快检（不改依赖、不触网）
node --check scripts/build-apk.mjs
node --check plugins/dsh-android-seagull/src/index.js
```

### 大资产与二进制（不入库）

| 资产 | 落点 | 来源 |
|------|------|------|
| 运行时快照 | `app/src/main/assets/snapshot.tar.xz` + `.sha256` | 云端从源重建，或 CI 回退下载上游官方 `snapshot-arm64.tar.xz` |
| Ubuntu rootfs | `app/src/main/assets/ubuntu-rootfs.tar.xz` | CI 从 termux/proot-distro Release（ubuntu-noble-aarch64-pd-v4.18.0）下载 |
| 内置工具 | `app/src/main/assets/tools/{apktool.jar,jadx.zip,radare2.tar.xz,rizin.tar.gz}` | CI 从各官方 Release 下载 |
| base 底座 | `base/base-{dsh,usr-arm64}.tar.xz`（LFS 指针） | fork 未传 LFS 对象 → CI 从上游 media 直连下载真实归档 |

运行时解压：`EngineManager.refreshSnapshot`（快照→usr/home）→ `extractToolAssets`（tools→usr/share，rootfs→home/.dsh/ubuntu-rootfs + proot-entry.sh）。

## 构建与验证

### 云端一键（推荐）

推送 main（或 workflow_dispatch）→ `.github/workflows/build-apk.yml` 从源重建快照 + 构建 APK，产物 `out/v0.13.0/dsh-mobile-apk-v0.13.0[后缀]-arm64.apk` 以 artifact 提供（本地下载 debug，不出 Release）。

### 本地构建（需先备齐大资产与依赖）

```bash
# 1) 备齐快照（方法见「大资产」表）
# 2) 构建 TS 插件到 lib/
(cd dsh-shell-termux && npm install && npm run build)
(cd plugins/dsh-android-bridge && npm install && npm run build)
(cd plugins/dsh-android-manage && npm install && npm run build)
(cd plugins/dsh-android-linux-env && npm install && npm run build)
(cd plugins/dsh-android-file-open && npm install && npm run build)
(cd dsh-client-ui-responsive && npm install && npm run build)
# 3) Seagull 纯 JS 插件
node scripts/build-plugin.mjs seagull root-ops dev-tools apk-tools tool-installer
# 4) 编排注入 + 门禁 + gradle
node scripts/build-apk.mjs --abi arm64 --suffix "-local"
```

产物：`out/v0.13.0/dsh-mobile-apk-v0.13.0-local-arm64.apk`（debug 签名，keystore/debug.keystore 固定，可覆盖安装同签名旧包）。

### 门禁清单（build-apk.mjs 内嵌，任一不过即拒发）

1. `patch-undo-mobile.mjs --check` / `patch-marketplace.mjs`：vendor 补丁修复校验
2. `inject-snapshot.py` + `inject-external-plugins.py`：把 pluginDirs/vendor 的 lib/ + package.json（+ persona.md）注入快照 profile node_modules
3. `update-snapshot-patch.py`：`profile-web.cordis.patch.yml` 权威覆盖快照内 cordis.patch.yml
4. `check-patch-mounts.mjs`：挂载集 ⊇ 注入集
5. `check-third-party.mjs`：GPL 义务（80 组件矩阵、copyleft 全文三形态在场）
6. `check-snapshot-secrets.mjs`：机密泄漏
7. `elf-check.mjs`：快照 node ELF 架构 = arm64（防 ABI 错配）

### 运行与设备验证

```bash
adb -s <serial> install -r -t out/v0.13.0/dsh-mobile-apk-v0.13.0-local-arm64.apk
adb -s <serial> forward tcp:23080 tcp:32080     # 引擎探活
# 浏览器/curl http://127.0.0.1:23080/  访问引擎 Web UI
# WebView CDP 调试见 AGENTS.md §2
```

注意：首装/指纹变更会触发 `refreshSnapshot` 全量重解压（数分钟，勿杀进程）。APK 仅 arm64——arm64 真机安装需 arm64 快照（构建产物即 arm64）。

## 开发工作流

### 代码质量工具

| 工具 | 命令 | 目的 |
|------|------|------|
| Kotlin 壳 | （gradle 构建时类型检查） | 修改后跑 `./gradlew :app:compileDebugKotlin` 验证 |
| 纯 JS 插件/脚本 | `node --check <file>` | 语法检查（低成本首选） |
| TS 插件 | `cd <pkg> && npm run build` | tsc 类型检查 + 产出 lib/ |
| 前端注入层 | `cd dsh-client-ui-responsive && npm test && npm run build` | 单元测试（vitest）+ tsdown |
| 快照相关 | `scripts/check-prefix-residue.sh` | 设备端旧前缀自检 |
| 构建门禁 | 见上「门禁清单」 | 打包前置 |

### 修改规范（三必做）

改代码后收尾必须：
1. **文档同步**：AGENTS.md（与 .monkeycode/docs/）描述失真处当场更新 + 文末更新记录表登记（时间/版本/内容）。
2. **GPL 合规**：新增第三方依赖登记 `scripts/third-party-licenses.json` + `THIRD_PARTY_NOTICES.md`；copyleft 全文三形态在场。
3. **PR 规范**：标题 `<type>: <描述>`（fix:/feat:/docs:/chore:）；破坏性变更 type 后加 `!`；禁用 emoji。

### 分支策略与 PR

- `main` 为发布主干（云端构建推 main 即触发）。
- fork 的改动走分支 + PR（本仓为 fork，PR 回上游需对照协调流程）。
- 提交前 `git status` + `git diff` 检查，只暂存意图内文件，不提交机密。

## 常见任务

### 修复引擎启动/崩溃问题

1. 打开内置控制台或 `adb shell cat /data/data/com.dsharnessmobile.shell/files/engine.log(.1/.2)`
2. 现场已镜像到 `Documents/dshdata/diagnostics/<ts>-<reason>/`（engine.log 全世代 + 设备信息 + logcat）
3. 定位后改 Kotlin/插件/快照装配，改完跑对应语法/门禁检查
4. 装机验证（引擎端口 32080，勿用 3080）

### 新增/修改一个 cordis 插件

1. 纯 JS 插件：写 `plugins/dsh-android-<name>/src/index.js`（不要加注释冗余），`package.json` name 以 `@dsh-android/` 开头、main 指 `lib/index.js`
2. 构建：`node scripts/build-plugin.mjs <name>`（CI 循环会构建）
3. 装配：确认 `scripts/profile-web.cordis.patch.yml` insert 块含该 id/name（缺失即引擎不加载）
4. 注入契约：插件注入时需在 schema/inject 声明硬依赖（ctx.tools/settings 等），勿让 `ctx.get(...)` 静默 undefined
5. 跑 `check-patch-mounts.mjs` 门禁验证挂载 ⊇ 注入

### 改 UI 注入层（dsh-client-ui-responsive）

1. `cd dsh-client-ui-responsive && npm test`（改前先有红）
2. 实现 → `npm run build` → 产物进快照需重新构建/注入快照
3. 涉及桥方法同步更新 `AndroidBridge.kt` 与本文档接口表

### 排查授权（ADB/root）

- 授权真值只在壳：`dsh-adb` SharedPreferences（fullAccess/allowSwitch/paired）+ KernelSU root 探测。改引擎侧判定前先查壳。
- `adbShell`/配对码失败看归因：`classifyFailure`（window-closed/protocol-fault/server-not-ready/handshake-timeout），前端按 reason 分流文案。
- vivo 等厂商读 `service.adb.tls.*` 系统属性会被 SELinux 拒（avc denied adbd_prop）——端口发现靠 NSD/mDNS 兜底，勿依赖属性直读。

## 编码规范

### 命名与文件组织
- Kotlin 文件一个主题类（BootReceiver 等小类可并入宿主文件）；`TAG` 常量风格 `dsh-*`
- 桥方法名 = 页面 JS 调用名；返回值 JSON 用 org.json
- 纯 JS 插件：src/index.js 单一入口，defineTool 显式 schema
- 常量收敛：引擎端口只用 `EngineProbe.ENGINE_PORT`；品牌字符串走 res（app_name 等），不硬编码中英文案进 Kotlin

### 错误处理
- 壳层 best-effort 方法（诊断镜像/工具解压/数据还原）绝不抛出（捕获即日志）
- 授权/审计路径 fail-closed：未授权不静默执行，显式 return 结构化失败
- 秘钥文件只存私有域（files/*-key.txt），经 shellEnv 注入 env，源码/仓库零硬编码

### 更新记录
代码改动对应 AGENTS.md §9 的 fork 表与「更新记录表」追加登记（时间/版本/内容/更新者）。

## 常用陷阱（速查）

- **端口**：引擎 32080；`adb forward tcp:23080 tcp:32080` 用于宿主探活。见到 3080 即回归点。
- **ELF 直 exec**：app 域 exec 快照 ELF 会 EACCES/`not executable: 64-bit ELF`（run-as 裸环境更甚）——凡验证快照二进制都要走完整引擎 env + linker64/LD_PRELOAD 语境。
- **OPENSSL_CONF**：快照 node 编译期硬编码 com.termux 路径，缺注入则 node/npm 子进程启动即退出。
- **装配 ≠ 注入**：cordis.patch.yml 里 insert 的插件必须同时在快照 node_modules 有落点，否则引擎静默不加载。
- **快照指纹**：snapshot.tar.xz 与 snapshot.sha256 必须成对换（指纹变才触发重解压）。
- **assets 残留**：ps1 双 ABI 循环后 assets 会停在最后一个 ABI——真机安装只用命名产物，存疑时读 node ELF 机器码（183=arm64）。
