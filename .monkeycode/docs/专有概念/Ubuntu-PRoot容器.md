# Ubuntu PRoot 开发者容器

Seagull DevStudio 自带一个可离线使用的 Ubuntu 24.04（ARM64）用户态容器，用于运行快照内 Termux 不具备的完整发行版工具链（apt/dpkg/gcc/cmake/python3/java 等）。它基于 **proot**（无 root 的用户态 chroot）实现，容器 rootfs 内嵌在 APK assets 中，启动即用。

## 内嵌形态

- APK 资产：`assets/ubuntu-rootfs.tar.xz`（构建时由 CI 从官方 Release 下载落位；不入库，超 GitHub 100MB push 限制）。
- 运行时解压：`EngineManager.extractToolAssets()`（幂等）解到 `files/home/.dsh/ubuntu-rootfs/`，并在快照 `usr/bin` 装配 `proot`（Termux 源，快照 TARGETS 含 proot）。
- 容器顶层含 `proot-entry.sh`（构建期写入）——插件按 `${HOME}/.dsh/ubuntu-rootfs/proot-entry.sh` 调用。

## proot-entry.sh（启动器）

`proot-entry.sh` 是容器的统一入口。它设置 proot 用户态重路由（`-R rootfs` + fake sysdata：伪造 /proc 的 /dev/zero、CPU 信息等，规避 Android 受限 /proc），并准备容器内环境变量与动态链接路径（Termux 的 `LD_LIBRARY_PATH`/`termux-exec` 钩子按需传递或清空）。根文件系统顶层剥离（`bin`→`usr/bin` 软链语义）在解压时保留，避免 /bin、/lib 缺失导致容器起不来。

## 消费方

| 插件/工具 | 调用方式 |
|---|---|
| dev-tools `ubuntu_exec` | `execFile('/bin/bash', [proot-entry.sh, '-lc', command])` 进入容器执行构建/开发命令 |
| dev-tools `ubuntu_status` | 探测 rootfs 存在与大小 |
| tool-installer | `proot-entry.sh` 存在时经它执行文件移动（容器内可见性），否则裸 fs rename 兜底 |
| apk-tools | **不**经容器——宿主 Termux 双路径直接 java -jar 执行（usr/bin wrapper 优先 / usr/share 内置 jar 回退），见「宿主直跑」 |

> apk-tools 在 0.13.2-seagull 复盘后改为**宿主直跑**：apktool/jadx/apksigner 是 java -jar，无需容器发行版；绕开容器启动开销与 rootfs 依赖，仅要求宿主 `usr/bin/java`（openjdk-21，`install-java-tools.sh` 按需装配）。

## rootfs 构建链（开发期）

- `scripts/build-ubuntu-rootfs.sh`：proot-distro 或 debootstrap 交叉构建，产出 `app/src/main/assets/ubuntu-rootfs.tar.xz` + sha256。
- `scripts/launch_ubuntu_proot.sh`：独立启动器 + fake sysdata 挂载（开发机上手动进容器排障）。
- `scripts/setup_fake_sysdata.sh`：伪造 /proc 装配脚本。

## 边界与注意

- 容器内工具链实际能力受 proot 对 /proc、/sys 的伪造程度影响（非完整内核视图）；重系统调用（mount/iptables/特定 /proc 写）不可用。
- 运行容器命令是宿主 bash + proot 子进程，同样受 termux-exec 重路由环境约束；失败排查先核对 proot 是否在快照内（`usr/bin/proot`）。
- rootfs 首次解压与快照全量解压同属「大资产落位」，需在 app 未受限窗口完成，勿中断。
