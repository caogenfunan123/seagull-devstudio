#!/usr/bin/env bash
# ==============================================================================
# Seagull DevStudio - CI: 下载官方 minbase rootfs 后注入编译工具链再重打包
#
# 背景：termux/proot-distro 官方 ubuntu-noble-aarch64 rootfs 是 minbase（约 185
# 包），只有 dpkg/apt/bash 等最小集，没有 gcc/g++/make/cmake/java/git 等编译工具
# 链。旧 build-apk.yml 直接把该 minbase 资产当最终容器打进 APK，导致设备端容器
# 起得来但「编译工具链一个都没装」。本脚本在 CI（x86_64 runner）上：
#   解包 -> 注册 qemu binfmt（跑 arm64） -> chroot apt 注入工具链 -> 重打包。
# 保证构建出的 APK 内 Ubuntu 容器开箱即用可编译。
#
# 用法：inject-ubuntu-toolchain.sh <输入minbase.tar.xz> <输出rootfs.tar.xz> [abi]
# ==============================================================================
set -euo pipefail

IN_TAR="${1:?输入 minbase rootfs tar.xz 路径}"
OUT_TAR="${2:?输出 rootfs tar.xz 路径}"
ABI="${3:-arm64}"
OUT_DIR="$(cd "$(dirname "$OUT_TAR")" && pwd)"
OUT_NAME="$(basename "$OUT_TAR")"
WORK="$(mktemp -d)"
UNPACK="$WORK/unpack"
mkdir -p "$UNPACK"
trap 'sudo rm -rf "$WORK"' EXIT

echo "=== [1/5] 解包 minbase rootfs ==="
sudo tar -C "$UNPACK" -xJf "$IN_TAR"

# 探测顶层目录：proot-distro tar 顶层是单目录（如 ubuntu-noble-aarch64/）；平铺则无。
# 重打包必须保持与原资产相同的顶层结构，否则设备端 extractTarAsset(stripTopDir=true)
# 剥完顶层后 bin/bash 落错位置，容器起不来（真机日志实锤）。
ROOTFS="$UNPACK"
cnt="$(find "$UNPACK" -mindepth 1 -maxdepth 1 | wc -l)"
if [ "$cnt" = "1" ]; then
  TOP_DIRS="$(find "$UNPACK" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -n "$TOP_DIRS" ] && [ -d "$TOP_DIRS/etc" ]; then
    ROOTFS="$TOP_DIRS"
    echo "检测到顶层目录：$(basename "$TOP_DIRS")"
  fi
fi
echo "ROOTFS=$ROOTFS"

echo "=== [2/5] 注册 qemu binfmt（x86_64 runner 跑 arm64） ==="
if [ "$(uname -m)" != "aarch64" ]; then
  # 首选 docker multiarch（GitHub Actions ubuntu-latest 自带 docker，--privileged 可用）
  if command -v docker >/dev/null 2>&1; then
    docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null && echo "docker multiarch binfmt 已注册" || true
  fi
  # 兜底：apt qemu-user-static + binfmt-support，显式启用 aarch64 binfmt
  sudo apt-get update -y >/dev/null 2>&1 || true
  sudo apt-get install -y qemu-user-static binfmt-support >/dev/null 2>&1 || true
  sudo update-binfmts --enable qemu-aarch64 2>/dev/null || true
fi

echo "=== [3/5] 配置 DNS + apt sources ==="
# chroot 内 glibc 需要 resolv.conf 才能解析域名（minbase 资产通常不含或为空）
printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' | sudo tee "$ROOTFS/etc/resolv.conf" >/dev/null
# 确保 sources.list 含 universe（clang 等在 universe）；minbase 资产 sources.list 可能缺失
if [ ! -s "$ROOTFS/etc/apt/sources.list" ] || ! grep -q '^deb ' "$ROOTFS/etc/apt/sources.list" 2>/dev/null; then
  cat | sudo tee "$ROOTFS/etc/apt/sources.list" >/dev/null <<SRC
deb http://ports.ubuntu.com/ubuntu-ports noble main universe multiverse restricted
deb http://ports.ubuntu.com/ubuntu-ports noble-updates main universe multiverse restricted
deb http://ports.ubuntu.com/ubuntu-ports noble-security main universe multiverse restricted
SRC
fi

echo "=== [4/5] chroot 注入编译工具链 ==="
INIT="$WORK/init-rootfs.sh"
cat > "$INIT" <<'EOF'
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates curl wget git \
    build-essential clang cmake ninja-build \
    python3 python3-pip python3-venv \
    openjdk-17-jdk-headless \
    unzip zip tar xz-utils \
    tzdata locales
locale-gen en_US.UTF-8
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF
sudo cp "$INIT" "$ROOTFS/tmp/init-rootfs.sh"
# 挂载 /dev /dev/pts /proc /sys：openjdk postinst 与 apt 日志写需要 /dev/pts，
# 不挂载会 posix_openpt (19: No such device) → dpkg postinst 失败，工具链安装中断。
sudo mount --bind /dev "$ROOTFS/dev" 2>/dev/null || true
sudo mkdir -p "$ROOTFS/dev/pts"
sudo mount -t devpts devpts "$ROOTFS/dev/pts" 2>/dev/null || true
sudo mount -t proc proc "$ROOTFS/proc" 2>/dev/null || true
sudo mount -t sysfs sys "$ROOTFS/sys" 2>/dev/null || true
sudo chroot "$ROOTFS" /bin/bash /tmp/init-rootfs.sh
sudo umount "$ROOTFS/dev/pts" 2>/dev/null || true
sudo umount "$ROOTFS/dev" 2>/dev/null || true
sudo umount "$ROOTFS/proc" 2>/dev/null || true
sudo umount "$ROOTFS/sys" 2>/dev/null || true
sudo rm -f "$ROOTFS/tmp/init-rootfs.sh"

echo "=== [5/5] 重打包（保持顶层结构）+ sha256 ==="
sudo tar -C "$UNPACK" -cJf "$OUT_TAR" .
(cd "$OUT_DIR" && sha256sum "$OUT_NAME" > "${OUT_NAME}.sha256")
echo "完成：$OUT_TAR ($(du -sh "$OUT_TAR" | cut -f1))"
