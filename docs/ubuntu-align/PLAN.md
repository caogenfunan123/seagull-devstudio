# Ubuntu 容器自包含 proot 对齐计划

> 目标：把 Operit 的自包含 proot/loader 方案移植到 seagull，根治 Ubuntu 容器依赖 Termux proot 的脆弱链路（坑 38 三连失败）。
> 原则：每步产出文档 + 复盘，确认无问题再继续下一步；最小必要改动，不引入无关组件。

## 一、侦察结论（事实基线）

| 项 | 结论 |
|---|---|
| 设备 APK | versionCode 28 = 0.13.2-seagull，与源码一致 |
| rootfs 源 | CI 从 `termux/proot-distro` 下载 `ubuntu-noble-aarch64-pd-v4.18.0.tar.xz`（与 Operit 同款），经 `inject-ubuntu-toolchain.sh` 注入工具链重打包 |
| 壳侧平铺 | `EngineManager.extractTarAsset(..., stripTopDir = true)` 已有顶层剥离逻辑（源码已修） |
| proot 依赖 | 当前 fallback 用 Termux `$PREFIX/bin/proot` + `libexec/proot/loader`（坑 38：tmp 路径/loader 硬编码/termux-exec 拦截三连失败） |
| Operit 资产（本地已 clone） | `liboperit_proot.so`(257KB 动态, 依赖 libdl/libc)、`liboperit_loader.so`(1.6KB 静态)、`libbash.so`(1.7MB 静态)、`libbusybox.so`(1.5MB 静态)、`libsudo.so`(2 字节占位，忽略) |
| GPL 登记 | `third-party-licenses.json` 已有 proot=GPL-2.0、busybox=GPL-2.0；bash 未登记；LICENSES 全文在场 |
| 壳侧落点 | `usrDir = filesDir/usr`（即 Termux 快照 usr）；`homeDir = filesDir/home` |

## 二、核心决策（已拍板）

1. **rootfs**：保留 seagull 自建（工具链预装），不换 Operit 的纯净 rootfs。
2. **proot/loader**：引入 Operit 的 `liboperit_proot.so` + `liboperit_loader.so`（app 域定制，不硬编码 termux 路径）。
3. **bash/busybox**：**本次不引入**。seagull 的 rootfs 解压走壳侧 Kotlin（不需要 busybox），chroot 走系统 toybox，proot fallback 只需 proot + loader。最小必要原则。
4. **chroot 优先**：保留（KernelSU 可用，原生最快）。
5. **SSH/SFTP**：砍掉，单独立项。
6. **落地位置**：`app/src/main/assets/native/`（入库，约 260KB，远小于 100MB 限制）；运行解压到 `usr/share/operit-native/`，**不污染** `usr/bin`（避免覆盖 Termux 快照自带的 proot/bash）。

## 三、任务分解

### Step 0 — rootfs 平铺静态审查（不改代码，除非发现 bug）
- 审查 `extractTarAsset` 的 stripTopDir 逻辑边界 case。
- 结论记录：逻辑正确则标注「构建部署后验证」；有 bug 则修复。
- 产出：`STEP-00-rootfs-review.md` + `REVIEW-00.md`。

### Step 1 — 引入 Operit native 资产
- 从 operit clone 复制 `liboperit_proot.so`、`liboperit_loader.so` 到 `app/src/main/assets/native/`。
- 记录来源、版本、sha256。
- 产出：`STEP-01-native-assets.md` + `REVIEW-01.md`。

### Step 2 — 壳侧解压 + 软链
- `EngineManager.extractToolAssets` 增加 native 资产复制到 `usr/share/operit-native/{proot,loader}`（设 exec 位）。
- 幂等检查对齐。
- 产出：`STEP-02-shell-extract.md` + `REVIEW-02.md`。

### Step 3 — 重写 proot-entry.sh fallback 分支
- fallback 分支改用 `usr/share/operit-native/proot` + `PROOT_LOADER=usr/share/operit-native/loader`，不再依赖 Termux proot。
- 三处同步：`EngineManager.writeProotEntry` / `scripts/build-ubuntu-rootfs.sh` heredoc / `scripts/launch_ubuntu_proot.sh`。
- 产出：`STEP-03-proot-entry.md` + `REVIEW-03.md`。

### Step 4 — GPL 合规登记
- `third-party-licenses.json`、`THIRD_PARTY_NOTICES.md` 补 proot/loader 来源登记。
- 产出：`STEP-04-gpl.md` + `REVIEW-04.md`。

### Step 5 — rizin 静态 ELF 修复（独立问题）
- tool-installer 为 rizin 提供 root 通道执行（root 下已验证可跑），或换 PIE 构建。
- 产出：`STEP-05-rizin.md` + `REVIEW-05.md`。

### Step 6 — 推送构建 + 验证
- 提交 git、触发 CI（build-apk.yml）。
- 产出：`FINAL-REVIEW.md`（总体复盘）。

## 四、风险与规避

| 风险 | 规避 |
|---|---|
| stripTopDir 边界 bug（tar 顶层结构） | Step 0 静态审查 + 构建后设备验证落点 `bin/bash` |
| proot 动态依赖 libdl/libc 找不到 | Operit proot 只依赖系统库（/system/lib64），无需额外 LD_LIBRARY_PATH |
| 覆盖 Termux 快照 proot 破坏其他功能 | 落到独立目录 `usr/share/operit-native/`，不改 `usr/bin` |
| GPL 门禁拒打包 | Step 4 先过 check-third-party.mjs |
| 构建环境不在本机 | 走 CI（build-apk.yml），本会话只改源码 + 推 git |

## 五、文档规范

- 每步文档：`docs/ubuntu-align/STEP-NN-<slug>.md`（做了什么、改了什么、验证方式）。
- 每步复盘：`docs/ubuntu-align/REVIEW-NN.md`（结果 vs 预期、遗留问题、下一步）。
- 总体复盘：`docs/ubuntu-align/FINAL-REVIEW.md`。
