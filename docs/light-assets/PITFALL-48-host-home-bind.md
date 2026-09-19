# 坑 48：Ubuntu 容器开机装配脚本 over-broad bind（5GB 显示体积）

## 现象
手机「设置 → 应用 → Seagull DevStudio」显示占用 5GB+，`du -sh files` = 3.9GB。
逐层拆：真实占用约 2.6GB（出厂 minbase rootfs 280MB + 用户按需装的 jvm/llvm 工具链 ~900MB
+ 宿主 NDK usr/ 1.3GB + profiles 141MB），另外 ~2.2GB 是**虚高**。

## 根因
设备侧 `/data/adb/service.d/seagull-ubuntu.sh`（历史版本落盘的 KernelSU boot service）执行：

```sh
mount_bind "$HOST_HOME" "$ROOTFS/host-home"
# HOST_HOME = /data/data/<pkg>/files/home，ROOTFS = .../files/home/.dsh/ubuntu-rootfs
```

`ubuntu-rootfs` 本身住在 `files/home/.dsh/` 下 —— **bind 源是挂载点的祖先目录**，
于是 `host-home/.dsh/ubuntu-rootfs` 又指向 rootfs 自己。内核 bind 不真死循环（遍历遇
self-mount 即停），但 `du` 与 Android「应用大小」统计顺着这层 bind 把整块 home（2.5GB）
再数一遍 → 显示虚高 2.2GB。`du -x` 也救不了：`/data`、`/data/user/0`、`/data_mirror`
全是同一 dm-51 设备号，`-x` 按 dev 过滤不按 mount 过滤。

## 为什么主仓 grep/历史双零命中
该脚本运行期直接往 `/data/adb` 落盘，**从未进过本仓 git**（`git log --all -S host-home`
/ `-S mount_bind` / `-- **/service.d/**` 全空）。所以源码审查看不到，只能靠手机侧考古
（`/proc/1/mountinfo` 显示 init 命名空间里就挂着 + 源路径 `/data/<pkg>/...` 非标准 user/0
形态 → 定位到 root 权限的 service.d 脚本）。

## 修复（软件层，本仓接管）
1. `scripts/seagull-ubuntu-boot.sh` —— 该开机脚本的**唯一权威模板入仓**。窄 bind：只挂容器
   真消费的叶子目录（`.dsh/fetched` → `/host-shared/fetched`、`.dsh/workspaces` →
   `/host-shared/workspace`），**绝不 bind home/.dsh 祖先**；并在启动时幂等 `umount -l`
   摘除遗留 host-home 挂载。
2. `dsh-android-root-ops` 新工具 `ubuntu_boot_fix` —— 备份旧脚本（带时间戳 .bak）→ base64
   落盘权威版（`sh -n` 语法验证失败即回滚）→ 立即 `umount -l` 遗留 bind → 重跑 → 以
   `/proc/mounts` 里 host-home 计数归零为收敛判据。幂等，可重复调用。
3. `scripts/check-boot-script.mjs` 门禁 —— 强制插件内嵌 `BOOT_SCRIPT` 常量与 sh 模板逐字节
   一致（坑 45/47 同源方法论：两侧口径必须锁死）。

## 验证（沙箱模拟，不碰真 mount）
`/tmp/sim-boot.mjs`：假 `/proc/mounts` 预置遗留 host-home bind，桩化 mount/umount 记账：
① 遗留 bind 被摘除；② fetched/workspaces 窄 bind 挂上；③ 跑两遍幂等（mounts 不变、无重复）；
④ 红线——mounts 里无任何一条 src 是 home 或 .dsh 祖先。全绿。

## 设备侧现状
真实占用约 2.6GB；5GB 显示里 2.2GB 是 host-home bind 虚高。用户可按需装的 jvm/llvm 工具链
（~900MB）是 P2 设计意图（`docs/light-assets/ARCHITECTURE.md`），不是残留。可安全删的真残留
（settings_patch/settings_out/am_final 共 176MB）已由用户清除。
