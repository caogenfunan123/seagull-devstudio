#!/system/bin/sh
# =============================================================================
# Seagull DevStudio — Ubuntu 容器开机自启装配（受控模板 / source of truth）
#
# 安装位置： /data/adb/service.d/seagull-ubuntu.sh （KernelSU / Magisk boot service）
# 由 root-ops 插件 'ubuntu_boot_fix' 工具落盘/修补；本文件是仓库内唯一权威版本。
#
# 为什么有这个脚本（坑 48）：
#   历史版本把「整块 files/home」bind 进 rootfs/host-home，而 ubuntu-rootfs 本身就住在
#   files/home/.dsh/ 下 —— 于是 host-home 里又看到整块 home（含 rootfs 父目录）。
#   内核 bind 不会真死循环，但 du / Android「应用大小」统计顺着 host-home 把整块 home
#   再数一遍 → 设备显示 5GB（虚高 2.2GB）。
#   正确做法：只 bind「容器确实要读的最小宿主目录」（fetched / workspaces），
#   绝不 bind files/home 或 .dsh 这种「包含 rootfs 自身」的祖先目录。
# =============================================================================

PKG=com.dsharnessmobile.shell
DATA=/data/data/$PKG/files
HOME_DIR="$DATA/home"
ROOTFS="$HOME_DIR/.dsh/ubuntu-rootfs"
# 容器内共享根（叶子目录，绝不指向 home/.dsh 祖先）
FETCHED="$HOME_DIR/.dsh/fetched"
WORKSPACES="$HOME_DIR/.dsh/workspaces"
C_FETCHED="$ROOTFS/host-shared/fetched"
C_WORKSPACE="$ROOTFS/host-shared/workspace"

mount_bind() { # src dst —— 幂等：已挂同 src 到 dst 则跳过
  src="$1"; dst="$2"
  [ -e "$src" ] || return 0
  mkdir -p "$dst"
  if grep -q " $dst " /proc/mounts 2>/dev/null; then
    cur=$(awk -v d="$dst" '$2==d{print $1; exit}' /proc/mounts 2>/dev/null)
    [ "$cur" = "$src" ] && return 0
    umount -l "$dst" 2>/dev/null
  fi
  mount --bind "$src" "$dst" 2>/dev/null
}

# 0) 摘除历史遗留的「整块 home → host-home」over-broad bind（幂等，先摘后窄挂）
LEGACY="$ROOTFS/host-home"
if grep -q "$LEGACY" /proc/mounts 2>/dev/null; then
  umount -l "$LEGACY" 2>/dev/null
fi
rmdir "$LEGACY" 2>/dev/null

# 1) 标准 proc/dev/sys 挂载（root chroot 用；proot 路径不需要，各自幂等）
[ -d "$ROOTFS/proc" ] || mkdir -p "$ROOTFS/proc"
mount -t proc proc "$ROOTFS/proc" 2>/dev/null
mount --bind /dev "$ROOTFS/dev" 2>/dev/null
mount -t devpts devpts "$ROOTFS/dev/pts" 2>/dev/null

# 2) 窄共享 bind（关键修复）：只暴露容器要读的叶子目录，绝不 bind home/.dsh 祖先
mount_bind "$FETCHED"    "$C_FETCHED"
mount_bind "$WORKSPACES" "$C_WORKSPACE"

# 3) DNS（rootfs 若无 resolv.conf 则写占位）
[ -s "$ROOTFS/etc/resolv.conf" ] || printf 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n' > "$ROOTFS/etc/resolv.conf" 2>/dev/null

# 4) qemu binfmt（仅当存在静态 qemu-aarch64 注册器时；best-effort，失败不影响原生 arm64 设备）
[ -x /data/local/tmp/qemu-aarch64-static ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] && {
  mount -t binfmt_misc none /proc/sys/fs/binfmt_misc 2>/dev/null
  printf ':qemu-aarch64:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x00\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/data/local/tmp/qemu-aarch64:OC\n' >/proc/sys/fs/binfmt_misc/register 2>/dev/null
}

exit 0
