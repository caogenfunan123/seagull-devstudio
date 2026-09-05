# 接口文档

Seagull DevStudio 的接口面分四层：页面→壳的 JS 桥、壳→引擎的 HTTP、引擎→插件的 cordis 服务面、插件→页面的前端注入面。以下契约以 `app/src/main/java/com/dshmobile/shell/AndroidBridge.kt` 与插件源码为准（0.13.2-seagull）。

## 1. 页面 → 壳：`window.androidBridge`（JS 桥，version v1）

注入点：`MainActivity.configureWebView` → `addJavascriptInterface(bridge, "androidBridge")`。桥方法用 `@JavascriptInterface` 暴露；同步方法直接返回，异步结果经 `window.__dshBridge.onDirectoryPicked(callbackId, path)` 等回传。

### 同步查询

| 方法 | 签名 | 说明 |
|------|------|------|
| `version` | `() → string` | 应用版本号（`BuildConfig.VERSION_NAME`，如 `0.13.2-seagull`） |
| `getSystemDark` | `() → boolean` | 系统深色模式（绕过部分厂商 WebView matchMedia 失效，首帧主题） |
| `checkEngine` | `() → string` | 探测 `127.0.0.1:32080`；JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | `() → boolean` | 是否已授予「所有文件访问」；API<30 恒 false |
| `getPickToken` | `() → string?` | 目录选择桥一次性 token（引擎侧 pick 端点校验；null=禁用） |
| `copyText` | `(text) → boolean` | 原生剪贴板写入（WebView clipboard API 被拒时的回退） |
| `getDevLogEnabled` | `() → boolean` | dev 日志开关 |
| `exportConfig` | `() → string` | 导出配置到 `Documents/dshdata/exports/config/settings.yaml`；JSON `{ok, path?, error?}` |
| `importConfig` | `() → string` | 从共享目录导入配置回私有 DSH_HOME；JSON `{ok, path?, error?}` |
| `getAdbState` | `() → string` | 授权状态 JSON（见下） |
| `discoverAdbPorts` | `() → string` | 自动发现无线调试端口（配对端口候选 JSONArray；未开无线调试返回 `[]`） |
| `adbShell` | `(cmd) → string` | ADB shell 执行原语；JSON `{ok, stdout?, stderr?, guidance?}`；未授权 fail-closed |
| `setAdbPair` | `(code, pairPort, connectPort) → string` | 门3 配对：真执行 `adb pair`；返回 JSON `{ok, reason, message}`（reason 归因 window-closed / protocol-fault / server-not-ready / handshake-timeout 等） |
| `openNativePath` | `(path) → boolean` | 用外部阅读器打开文件路径（FileProvider content Uri，`ACTION_VIEW`） |
| `getOverlayEnabled` | `() → boolean` | 悬浮球开关态 |
| `setOverlayEnabled` | `(enable) → boolean` | 悬浮球开关（控制器负责权限引导）；返回是否已启动 |

### 命令（无返回值）

| 方法 | 签名 | 说明 |
|------|------|------|
| `keepScreenOn` | `(enable)` | 屏幕常亮 |
| `showNotification` | `(title, text)` | 通知测试/通用通道（POST_NOTIFICATIONS） |
| `pickDirectory` | `(callbackId)` | SAF 目录选择；经 `__dshBridge.onDirectoryPicked(callbackId, path)` 异步回传真实路径或 content URI |
| `pickImage` | `(callbackId)` | SAF 图片选择；同上异步回传 |
| `setTextZoom` | `(percent)` | WebView 字号（50–200） |
| `setImmersiveMode` | `(enable)` | 沉浸式状态栏 |
| `downloadDebugLogs` | `()` | 导出引擎日志 + 环境信息压缩包 |
| `requestAllFilesAccess` | `()` | 打开系统「所有文件访问」授权页 |
| `restartEngine` | `()` | 重启引擎进程（EngineService 看门狗拉起） |
| `shutdownToGuide` | `()` | 停引擎回引导页（不自动重启） |
| `reloadWebUI` | `()` | 重载 Web UI |
| `openConsole` | `()` | 打开内置 bash 控制台 |
| `setDevLogEnabled` | `(enabled)` | dev 日志开关 |
| `setAdbAllow` | `(enable)` | 门2「允许访问」开关 |
| `revokeAdbPair` | `()` | 回收配对（disconnect + 删 adbkey + 清状态） |

### 授权状态 JSON（`getAdbState`，壳侧）

```json
{
  "tier": "T0",
  "fullAccess": false,
  "allowSwitch": false,
  "paired": false,
  "wirelessDebugOn": false,
  "connected": false,
  "authorized": false,
  "message": "请先授予「所有文件访问」并开启允许开关，再配对"
}
```

门 1（All Files Access）+ 门 2（开关）+ 门 3（配对）；`authorized = fullAccess && allowSwitch && paired`，`tier` 在已配对且连接时为 `T1`、已配对未连接为 `T1-connecting`，否则 `T0`。`message` 仅在未授权时非空。

`rootChannel`（KernelSU su 探测）**不在**壳 `getAdbState` 内——它是引擎侧 bridge 插件的 `currentStatus` 信息位（见下），仅用于 UI 显示「root 通道已就绪」，不翻转 ADB 授权门（ADB 工具未配对仍 fail-closed）。

## 2. 壳 → 引擎：本地 HTTP `127.0.0.1:32080`

| 端点/用途 | 说明 |
|-----------|------|
| `GET /` | 引擎 Web UI（WebView 加载） |
| `GET /api/...` | dsh 引擎 API（信封式 `{"type":"client-request","rpcId":…,"method":…,"payload":{}}`） |
| `POST /api/android/file-incoming` | F5 文件直达（`maybeProcessIncoming` → FileIncoming → 引擎新建临时工作区会话） |
| pick 端点（host-web-compat） | 目录选择，`x-dsh-pick-token` 鉴权（`DSH_PICK_TOKEN` env 注入） |
| `/api/android/privilege/status` | 授权状态只读端点 |

引擎端口常量：`EngineProbe.ENGINE_PORT = 32080`、`ENGINE_URL`。代码内不得再硬编码 3080。

## 3. 引擎 → 插件：cordis 服务面（`@dsh-android/*`）

插件在 `scripts/profile-web.cordis.patch.yml` 装配（authority），挂载于快照 profile node_modules。主要服务面与工具：

| 插件包 | id | 提供能力 |
|--------|----|---------|
| `@dsh-android/dsh-shell-termux` | shell-termux | bash 执行器：显式 Termux env 注入、写面栅栏（workspace-write / danger-full-access）、超时（默认 120s / 上限 600s） |
| `@dsh-android/dsh-android-bridge` | android-bridge | 授权状态机（currentStatus）、ADB/root 探测、审计、execAdbShell/execAdbLine、`gateFor(session)` 会话级 danger 门控 |
| `@dsh-android/dsh-android-seagull` | dsh-android-seagull | 海鸥 persona 注入（读包内 `persona.md`，经 `system-prompt/assemble` 注入每条会话） |
| `@dsh-android/dsh-android-root-ops` | dsh-android-root-ops | `root_exec`/`device_ui_control`/`root_status`；rootKeepalive 服务（60s 心跳巡检 su + KernelSU allowlist 校验/写入） |
| `@dsh-android/dsh-android-dev-tools` | dsh-android-dev-tools | `ubuntu_exec`/`ubuntu_status`：进 Ubuntu PRoot 容器执行 |
| `@dsh-android/dsh-android-apk-tools` | dsh-android-apk-tools | `apk_decompile`/`apk_build_sign`：apktool→zipalign→apksigner（宿主路径，不经容器） |
| `@dsh-android/dsh-android-tool-installer` | dsh-android-tool-installer | `tool_install`/`tool_list`；toolInstaller 服务（L1 内建 apktool/jadx，L2 选装 radare2/rizin） |
| `@dsh-android/dsh-android-manage` | android-manage | 设备观察/动作/等待闭环（全部失败关闭） |
| `@dsh-android/dsh-android-linux-env` | android-linux-env | 工具链/环境配方/共享目录设置视图（shell-termux 写面栅栏维护面） |
| `@dsh-android/dsh-android-file-open` | android-file-open | 外部文件强制新会话请求/状态/临时工作区 registry |
| `@dsh-android/dsh-client-ui-responsive` | ui-responsive | 移动 UI（AppFrame/DevSection/设置项注入/F5 消费端轮询） |
| `@dsh-android/dsh-host-web-compat` | host-web-compat | 老内核 polyfill + Android 目录选择 host（native 单例） |
| `dsh-undo-savepoint` | dsh-undo-savepoint | 配置+插件代码树快照/撤销/安全模式 |
| `dshmarketplace-plugin` | dshmarketplace | 内置插件市场（会话 /store、设置页市场、agent 工具） |
| `dsh-attachment-formats` | attachment-formats | 附件格式扩展（PDF/Office；tesseract OCR） |
| `@deepseek-ai/dsh-agent-default-model` | agent-default-model-mobile | 默认模型 provider=deepseek-official / deepseek-v4-flash |
| `@deepseek-ai/dsh-client-ui-directory-picker-native` | picker-native-surface | 目录选择 renderless 流程（调 host.pickDirectory） |

**契约要点**：
- 装配与注入分离：`profile-web.cordis.patch.yml` 定义装配；`inject-snapshot.py`/`inject-external-plugins.py` 只注入 `lib/` 与 `package.json`（+ `persona.md` 白名单文件）；`check-patch-mounts.mjs` 门禁「挂载集 ⊇ 注入集」。
- 插件需在 `inject`/`schema` 声明硬依赖（如 `ctx.tools`、`ctx.settings`），否则 `ctx.get(...)` 静默 undefined（历史上 seagull 5 插件的已知坑，修复模式为 defineTool + inject 声明，勿回退）。
- ADB 能力（含观察类）仅 danger-full-access 开放；自动审批不参与（`gateFor(exec.agent.session)` 实时 resolve）。

## 4. 插件 → 页面：dsh.client 模块 + slots

| 注入面 | 插件 | 内容 |
|--------|------|------|
| AppFrame / 响应式布局 | dsh-client-ui-responsive | 手机端抽屉/sheet、字体、沉浸式状态栏、深色主题 |
| DevSection | dsh-client-ui-responsive | 开发者选项（含导出/导入配置、日志、悬浮球、ADB 设置入口） |
| settings.dev.item | bridge | AdbAuthSection（配对 UI，双错误通道 pollError/actionError） |
| androidPrivilege 状态机 | android-bridge | currentStatus 事件流（fullAccess/allowSwitch/paired/rootChannel） |
| F5 消费端轮询 | ui-responsive + file-open | 文件直达会话请求/状态 |

## 5. 进程与环境注入（壳 → 引擎子进程）

`EngineManager.shellEnv()` 注入（引擎/控制台/UndoGate/ADB 共用）：

- `PATH`=usr/bin:/system/bin；`LD_LIBRARY_PATH`=usr/lib；`HOME`=files/home；`DSH_HOME`=files/home/.dsh（私有域）；`TMPDIR`=files/home/tmp
- `LD_PRELOAD`=libtermux-exec-ld-preload.so + `TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force`（exec 重路由）
- `SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`GIT_SSL_CAINFO`/`OPENSSL_CONF`（快照编译期 com.termux 路径不可读的覆盖）
- `DSH_PICK_TOKEN`（目录选择鉴权）、`DSH_ADB_ALLOW`/`DSH_ADB_PAIRED`/`DSH_ADB_WIRELESS`/`DSH_ADB_FULLACCESS`（授权 live 态，后者仅兜底）
- `DASHSCOPE_API_KEY`/`DEEPSEEK_API_KEY`（私有文件注入，非源码硬编码）
- `NODE_COMPILE_CACHE`（node 预热 v8 缓存）
