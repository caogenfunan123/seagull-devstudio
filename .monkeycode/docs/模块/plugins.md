# 模块：plugins（cordis 插件与注入层）

本仓插件分四类：Seagull 5 纯 JS、上游 TS 桥插件、执行器/UI 注入子仓库、固化第三方（vendor）。外加 `presets/` persona 源稿。

## Seagull 5 纯 JS 插件（`plugins/dsh-android-*`，src → lib 构建，lib 不入库）

| 插件 | 工具/服务 | 职责 |
|---|---|---|
| dsh-android-seagull | persona 注入 | 加载包内 `persona.md`（= presets 海鸥 3.0 完整破甲），经 system-prompt/assemble 注入每条会话；包路径三级回退（HERE/node_modules 装配路径） |
| dsh-android-root-ops | root_exec / device_ui_control / root_status + rootKeepalive 服务 | su 干净环境执行（uid=0）；UI dump/tap/swipe/input/keyevent；root 保活 60s 心跳 + KernelSU allowlist 自愈写入；root 感知提示仅 danger-full-access 注入 |
| dsh-android-dev-tools | ubuntu_exec / ubuntu_status | 经 proot-entry.sh 进 Ubuntu 容器执行构建/开发命令；状态报告 |
| dsh-android-apk-tools | apk_decompile / apk_build_sign | APK 逆向/重建/签名。宿主 Termux 双路径执行：usr/bin wrapper（install-java-tools.sh）优先，回退 usr/share 内置 jar + java；**不经容器**。zipalign 可选、apksigner debug 签 |
| dsh-android-tool-installer | tool_install / tool_list + toolInstaller 服务 | 三层注册表：L1 内建（apktool/jadx 自动）、L2 选装（radare2/rizin）；官方 Release https 下载 + proot mv/裸 rename 落位 |

统一模式：`export const inject = ['tools']` + `defineTool(...)` + `apply(ctx){ ctx.tools.register(t) }`；`ctx.provide` 暴露服务。均为 ESM、无依赖（除 @deepseek-ai/dsh-tools 类型/defineTool）。

## 上游 TS 桥插件（`plugins/dsh-android-{bridge,manage,linux-env,file-open}`）

| 插件 | 职责 |
|---|---|
| dsh-android-bridge | 授权状态机/审计/失败关闭/通知事件桥/root 通道探测/ADB 授权 UI 注入（AdbAuthSection）+ AndroidBridge 消费端 |
| dsh-android-manage | 设备观察/动作/等待闭环工具（shell/dumpsys/input 等，全部失败关闭） |
| dsh-android-linux-env | 工具链状态/环境配方/共享目录设置视图 |
| dsh-android-file-open | 外部文件直达会话（workspace 注册 + 清理） |

各目录含 package.json + tsconfig + build-client.mjs（UI 端产物），`src/`→`lib/` 构建。

## 执行器与 UI 注入（嵌仓子项目，独立构建）

- `dsh-shell-termux/`：bash 执行器（Termux env 语义），profile 装配 config 落点（bashPath/prefix/home/workspaceRoot/writeMode）。
- `dsh-client-ui-responsive/`：移动 UI 注入层（AppFrame/DevSection/settings.dev.item/F5 消费端轮询）；`npm test && npm run build`。
- `dsh-host-web-compat/`：页面注入 + 目录选择宿主（native dir-pick + token + SAF）。

## 固化第三方（vendor/）

- `dsh-undo-savepoint/`：崩溃回退/撤销保护安装，与 marketplace 共用机制。
- `dshmarketplace-plugin/`：内置插件市场。
- 两者为固化副本，改动见 PATCHES.md（双仓同步）。

## 装配与门禁

装配清单唯一权威 `scripts/profile-web.cordis.patch.yml`；注入 `scripts/inject-snapshot.py`（按目录名把 lib/ 打入快照 node_modules）；`check-patch-mounts.mjs` 校验挂载集 ⊇ 注入集。升级 dsh 后注意 index.html 哈希与模块脚本同步。

## presets/

- `presets/seagull-root/SEAGULL_FULL_INSTRUCTIONS.md`：海鸥 3.0 完整提示源稿（= persona）。
- 运行时生效路径为 seagull 插件注入（包内 persona.md 随插件装配携带），preset 目录为源稿非直读。

## 开发注意

- 改插件后重装配快照 + 冷启动 app 才生效（watchdog 热重启不重读 profile）。
- 工具返回经 `output.render` 类型闸：非 string 一律 JSON 转写，杜绝 `[object Object]` 转录事故。
- collectText 解包约定：引擎工具输出为结构体，字符串直取即坏。
