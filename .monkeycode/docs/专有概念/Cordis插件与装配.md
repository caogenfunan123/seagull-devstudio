# Cordis 插件与装配

dsh 引擎基于 [cordis](https://cordis.js.org) 插件框架。Seagull DevStudio 的全部 AI 可见能力（bash 执行、文件直达、ADB/root 授权、Ubuntu 容器、APK 工具链、通知、市场、undo 快照、UI 注入）都由 cordis 插件提供，装配清单由 `scripts/profile-web.cordis.patch.yml` 唯一权威驱动。

## 装配机制

- 引擎启动时读取快照内 profile（`cordis.patch.yml` / `*.cordis.patch.yml`），按清单 mount 插件。
- 构建链在快照重建时用 `profile-web.cordis.patch.yml` **权威覆盖**快照内同名文件（`update-snapshot-patch.py`），缺清单即 `process.exit` 拒发——根治「插件注入了但引擎不加载」的历史缺陷。
- 插件代码与前端注入层（`@dsh-android/*`、`dsh-*`）在构建期注入快照 node_modules；装配后的挂载集必须 ⊇ 注入集（`check-patch-mounts.mjs` 门禁）。

## 装配清单（profile-web.cordis.patch.yml 摘要）

| id | name | 职责 |
|---|---|---|
| dsh-android-seagull | @dsh-android/dsh-android-seagull | persona 注入：加载包内 persona.md，经 system-prompt/assemble 注入每条会话 |
| dsh-android-root-ops | @dsh-android/dsh-android-root-ops | root 通道：root_exec/device_ui_control/root_status + 保活自愈（allowlist 写入） |
| dsh-android-dev-tools | @dsh-android/dsh-android-dev-tools | ubuntu_exec/ubuntu_status：进 PRoot Ubuntu 容器执行 |
| dsh-android-apk-tools | @dsh-android/dsh-android-apk-tools | apk_decompile/apk_build_sign：宿主双路径（usr/bin wrapper / 内置 jar） |
| dsh-android-tool-installer | @dsh-android/dsh-android-tool-installer | tool_install/tool_list + toolInstaller 服务（L1 内建/L2 选装） |
| shell-termux | @dsh-android/dsh-shell-termux | bash 执行器（bashPath/prefix/home/workspaceRoot 配置；writeMode=workspace-write 部署默认） |
| host-web-compat | @dsh-android/dsh-host-web-compat | 页面注入 / 目录选择器宿主（native dir-pick + token） |
| ui-responsive | @dsh-android/dsh-client-ui-responsive | 移动 UI 注入层（AppFrame/DevSection/F5 消费端） |
| attachment-formats | dsh-attachment-formats | 附件格式扩展（PDF 文本层/Office/扫描 OCR） |
| dsh-undo-savepoint | dsh-undo-savepoint | 崩溃自动回退 / 撤销保护安装 |
| dshmarketplace | dshmarketplace-plugin | 内置插件市场（/store、agent 工具与技能文件） |
| android-bridge | @dsh-android/dsh-android-bridge | 授权状态机 / 失败关闭 / 审计 / 通知事件桥 / root 通道探测 |
| android-manage | @dsh-android/dsh-android-manage | 设备观察/动作/等待闭环工具 |
| android-linux-env | @dsh-android/dsh-android-linux-env | 工具链状态 / 环境配方 / 共享目录设置（shell-termux 写面栅栏维护面） |
| android-file-open | @dsh-android/dsh-android-file-open | 外部文件直达会话 |
| agent-default-model-mobile | @deepseek-ai/dsh-agent-default-model | 默认模型 provider=deepseek-official/model=deepseek-v4-flash |
| picker-native-surface | @deepseek-ai/dsh-client-ui-directory-picker-native | 渲染无头目录选择流程（宿主独占能力） |

## 插件形态与构建

- **Seagull 5 纯 JS 插件**（plugins/dsh-android-{seagull,root-ops,dev-tools,apk-tools,tool-installer}）：`src/index.js` → `lib/index.js`（`scripts/build-plugin.mjs`，tsdown/纯拷贝），`lib/` 不入库。统一模式：`export const inject = ['tools']`（显式声明硬依赖，修复 `ctx.get('tools')` 静默 undefined）+ `defineTool(...)` 定义 + `apply(ctx)` 内 `ctx.tools.register(t)`。
- **上游 TS 插件**（bridge/manage/linux-env/file-open）：`src/` → `lib/`（各自 package.json 构建脚本），注入 `scripts/inject-snapshot.py` 按目录名把 `lib/` 打进快照 node_modules 的 `@dsh-android/*` 落点。
- **执行器/注入子仓库**：dsh-shell-termux、dsh-client-ui-responsive、dsh-host-web-compat 嵌于本仓。

## 插件服务面与事件

- `ctx.provide('toolInstaller'|'rootKeepalive', service)`：插件级服务（本插件工具内闭包引用，或跨插件查询状态机）。
- `ctx.on('system-prompt/assemble')`：persona / root 感知提示注入点。
- `ctx.on('session/event')`（bridge）：捕获 `assistant/message` 写 `.task-done.ndjson` 标记 → 壳 WatchdogV2 消费发通知。
- `ctx.tools.register` / `defineTool`：模型工具面；`output.render` 类型闸防 `[object Object]` 转录事故。

## 装配注意

- 快照内热改 cordis.patch.yml 必须**冷启动 app**（force-stop + start）才重装配；watchdog 热重启引擎不重读 profile。
- 升级 dsh 后，其内核对 index.html 模块脚本哈希同步更新，否则前端 polyfill 注入点失效（老内核 ES2022 兼容，Chromium<92 缺 Object.hasOwn/Array.at 等）。
