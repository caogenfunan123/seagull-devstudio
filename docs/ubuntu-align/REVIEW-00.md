# Review 0 — rootfs 平铺审查复盘

## 结果 vs 预期

- 预期：静态审查 `stripTopDir`，确认逻辑是否正确，判断设备「多套一层」是 bug 还是旧残留。
- 实际：**壳侧 stripTopDir 逻辑正确**，根因在 CI 重打包脚本 `inject-ubuntu-toolchain.sh` line 101 用了错误的源目录（`$UNPACK` 而非已剥 distro_name 的 `$ROOTFS`），产出双重顶层 tar，stripTopDir 只剥一层导致残留。已修复。

## 关键澄清

之前「设备 versionCode 28 = 源码」说明设备跑的就是当前源码，不存在「旧 APK 未重构建」。真正的 bug 在**构建链**（inject-ubuntu-toolchain.sh），是「改对了代码但 tar 结构产出错了」。

## 遗留问题

- 设备端已解压的多套一层 rootfs 是历史残留，需重新构建 APK + 重新部署触发重解压后自然修正。
- `ubuntu_status` 检测 `bin/bash` 落点，修复后重新解压即可通过，无需改插件代码。

## 下一步

Step 1：引入 Operit native 资产（`liboperit_proot.so` + `liboperit_loader.so`）。
