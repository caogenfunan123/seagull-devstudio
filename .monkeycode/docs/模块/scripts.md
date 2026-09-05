# 模块：scripts（构建链、门禁与 CI 编排）

`scripts/` 是构建链唯一入口集。快照从源重建 → 插件构建 → 注入 → 门禁 → gradle 打包；云端 CI 从源重建自包含（base/ LFS 底座 + 官方 Release 下载），本地按需。

## 阶段编排入口

| 脚本 | 职责 | 产物 |
|---|---|---|
| build-snapshot-arm64.mjs | fork 快照构建（arm64，Termux 源 + TARGETS + proot/java + 插件装配 + persona） | `out/` snapshot.tar.xz + sha256 |
| build-apk.mjs | 云端/本地一键：插件构建→注入→门禁→gradle | `out/v<版本>/dsh-mobile-apk-v<版本>-arm64.apk` |
| build-apk-013.ps1 | Windows 本地链（协调仓时代遗留；fork 用 build-apk.mjs） | APK |
| build-plugin.mjs | Seagull 纯 JS 插件 src→lib | plugins/*/lib/ |
| build.mjs | 通用编排入口 | — |
| build-ubuntu-rootfs.sh | Ubuntu rootfs 交叉构建（proot-distro/debootstrap） | assets/ubuntu-rootfs.tar.xz |
| assemble-arm64.py | 快照装配（arm64 变体） | — |

## 注入与装配

| 脚本 | 职责 |
|---|---|
| profile-web.cordis.patch.yml | cordis 装配权威清单（插件挂载列表 + shell-termux config + 默认模型） |
| inject-snapshot.py | 把 plugins/*/lib + persona.md 等注入快照 node_modules / profile 树 |
| inject-external-plugins.py | 注入 vendor/ 与外部插件固化副本 |
| update-snapshot-patch.py | 权威 patch 覆盖快照内 cordis.patch.yml（缺即拒发） |
| relocate-snapshot.py | 包内绝对路径修正（usr/data 错位剔除等） |
| fix-shebang.py | 快照内脚本 shebang 修正 |

## 门禁（任一不过即拒发）

| 脚本 | 校验 |
|---|---|
| check-patch-mounts.mjs | 挂载集 ⊇ 注入集（防注了不加载） |
| check-snapshot-secrets.mjs | 机密不入快照（跨平台替代 .ps1） |
| check-third-party.mjs | 第三方 GPL 合规（80 组件矩阵 + copyleft 全文三形态在场） |
| check-contract.mjs / contract.json | 插件/装配契约校验 |
| elf-check.mjs | 快照 node ELF 架构（183=arm64，防 ABI 错配） |
| check-prefix-residue.sh | 设备端自检：编译期前缀残留（/data/data/com.termux 等） |
| ci-verify-snapshot.py | CI 快照验证 |
| auto-approve.mjs | 门禁自动放行辅助 |
| check-snapshot-secrets.ps1 | Windows 本地版机密检查 |

## 发布与设备部署

| 脚本 | 职责 |
|---|---|
| upload-release.mjs | Release 资产上传（注意 REPO 指向上游 dsh-mobile-apk） |
| sync-release-notes.mjs / build-release.ps1 | Release notes / 发布装配 |
| deploy-device.ps1 / deploy-embedded.ps1 / device-smoke.ps1 / e2e-phone-test.ps1 | 真机部署/冒烟/端到端 |
| t0-check.ps1 / continue-v3.ps1 / push-retry.ps1 | 门禁前置检查/断点续跑/push 重试（Windows 开发流） |
| smoke-bridge.mjs | bridge 18 断言单测 |
| test-download.ps1 / test-key.ps1 / test-workspace-pick.ps1 | 下载/密钥/SAF pick 冒烟 |
| snapshot-server.mjs | 本地快照分发（模拟上游 Release） |
| dsh-undo-emergency.mjs | UndoGate 急救 CLI（assets 同源拷贝） |
| launch_ubuntu_proot.sh / setup_fake_sysdata.sh | 开发机进 Ubuntu 容器 / 伪造 /proc |

## CI（.github/workflows）

- `build-apk.yml`：workflow_dispatch + push，arm64 从源重建（base/ LFS 底座、插件构建、工具与 rootfs 资产从官方 Release 下载、快照从源失败回退官方 v0.13.1 arm64 快照），仅 upload-artifact debug。
- `build-snapshot.yml`：快照构建工作流。
- `pr-gate.yml`：PR 门禁（语法/契约/合规点）。

## 输出约定

- APK 产物：`out/v<版本>/dsh-mobile-apk-v<版本>-arm64.apk`（版本由 gradle 单一来源）。
- 大资产输出：snapshot.tar.xz(+sha256)、ubuntu-rootfs.tar.xz、快照内置 tools（apktool/jadx/radare2/rizin）。
- `golden/`：门禁参考指纹/黄金样例。

## 关键坑

- 改构建脚本必须本地 `node --check`（曾有 # 误入 JS 数组字面量的 SyntaxError 事故）。
- LFS base 对象由 CI 从上游直连下载；fork 私库上游未托管对象时本地 base 仅指针。
- 命令/产物命名变更须同步 AGENTS.md 与本文档。
