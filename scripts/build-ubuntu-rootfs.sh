#!/usr/bin/env bash
# ==============================================================================
# Seagull DevStudio - Ubuntu 24.04 ARM64 PRoot 开发者运行容器构建脚本
#
# 目标：真实产出 app/src/main/assets/ubuntu-rootfs.tar.xz + .sha256
# 构建方式（二选一）：
#   A) 本机/CI 已装 Termux proot-distro：直接 proot-distro install ubuntu 后打包
#   B) 无 Termux（GitHub Actions ubuntu runner）：debootstrap + qemu-user-static 交叉构建
#
# 用法：./scripts/build-ubuntu-rootfs.sh [arm64|x86_64] [--ci]
# ==============================================================================
set -euo pipefail

ABI="${1:-arm64}"
MODE="${2:-}"
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${WORKSPACE_DIR}/app/src/main/assets"
BUILD_DIR="${WORKSPACE_DIR}/out/ubuntu-${ABI}-build"
ROOTFS_DIR="${BUILD_DIR}/rootfs"
TARBALL="${TARGET_DIR}/ubuntu-rootfs.tar.xz"

echo "=== [1/6] 初始化构建工作区 ==="
mkdir -p "${TARGET_DIR}" "${BUILD_DIR}" "${ROOTFS_DIR}"

echo "=== [2/6] 准备 Ubuntu 24.04 rootfs ==="
if command -v proot-distro >/dev/null 2>&1; then
    echo "[方式A] 使用 proot-distro"
    proot-distro install ubuntu --arch "${ABI}" --override-alias seagull-ubuntu
    ROOTFS_SRC="$(proot-distro rootfs seagull-ubuntu)"
    echo "proot-distro rootfs: ${ROOTFS_SRC}"
else
    echo "[方式B] 使用 debootstrap + qemu-user-static（CI 交叉构建）"
    if [ "${ABI}" = "arm64" ]; then
        FOREIGN="--foreign --arch=arm64"
    else
        FOREIGN="--foreign --arch=amd64"
    fi
    # CI runner 上的 debootstrap 交叉安装
    sudo debootstrap --variant=minbase --components=main,universe \
        ${FOREIGN} noble "${ROOTFS_DIR}" \
        http://ports.ubuntu.com/ubuntu-ports 2>/dev/null \
      || sudo debootstrap --variant=minbase --components=main,universe \
        ${FOREIGN} noble "${ROOTFS_DIR}" \
        http://archive.ubuntu.com/ubuntu
    # 若需在 x86_64 runner 上执行 arm64 二进制，注册 qemu-user-static
    if [ "${ABI}" = "arm64" ] && [ "$(uname -m)" != "aarch64" ]; then
        sudo docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null \
          || sudo cp /usr/bin/qemu-aarch64-static "${ROOTFS_DIR}/usr/bin/" 2>/dev/null || true
    fi
    ROOTFS_SRC="${ROOTFS_DIR}"
fi

echo "=== [3/6] 注入基础开发工具链（进入 rootfs 安装） ==="
INIT_SH="${BUILD_DIR}/init-rootfs.sh"
cat << 'EOF' > "${INIT_SH}"
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
# 逆向与打包工具（apktool/jadx 为独立 jar，运行时按需装配，不强制内置）
locale-gen en_US.UTF-8
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF
chmod +x "${INIT_SH}"

if command -v proot-distro >/dev/null 2>&1; then
    proot-distro login seagull-ubuntu -- bash -c "cat > /tmp/init-rootfs.sh && bash /tmp/init-rootfs.sh" < "${INIT_SH}"
else
    sudo cp "${INIT_SH}" "${ROOTFS_SRC}/tmp/init-rootfs.sh"
    # 用 qemu + chroot 执行初始化
    sudo chroot "${ROOTFS_SRC}" /bin/bash /tmp/init-rootfs.sh
    sudo rm -f "${ROOTFS_SRC}/tmp/init-rootfs.sh"
fi

echo "=== [4/6] 生成 PRoot 启动入口（放在 rootfs 顶层，供宿主调用） ==="
# 设计：插件按 ${HOME}/.dsh/ubuntu-rootfs/proot-entry.sh 调用本脚本；
# 该路径即「rootfs 目录 + 顶层 proot-entry.sh」。脚本自定位 rootfs = 自身所在目录。
cat << 'EOF' > "${ROOTFS_SRC}/proot-entry.sh"
#!/bin/bash
# Seagull DevStudio Ubuntu 容器入口（宿主侧 helper，rootfs 顶层）
# 用法：proot-entry.sh [-c "cmd"]   （不带参数进入交互 shell）
set -eu
ROOTFS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROOT_BIN="${PROOT_BIN:-$([ -x "${PREFIX}/bin/proot" ] && echo "${PREFIX}/bin/proot" || echo /data/data/com.dsharnessmobile.shell/files/usr/bin/proot)}"
if [ ! -x "${PROOT_BIN}" ]; then
    echo "[Seagull] proot 二进制未找到: ${PROOT_BIN}" >&2
    exit 1
fi
exec "${PROOT_BIN}" --link2symlink --kill-on-exit -0 \
    -r "${ROOTFS_DIR}" \
    -b /dev -b /proc -b /sys \
    -b /storage \
    -b "${HOME}:${HOME}" \
    -w "${HOME}" \
    /bin/bash "$@"
EOF
chmod +x "${ROOTFS_SRC}/proot-entry.sh"

echo "=== [5/6] 打包并生成 sha256 ==="
if command -v proot-distro >/dev/null 2>&1; then
    tar -C "${ROOTFS_SRC}" -cJf "${TARBALL}" .
else
    sudo tar -C "${ROOTFS_SRC}" -cJf "${TARBALL}" .
fi
(cd "${TARGET_DIR}" && sha256sum ubuntu-rootfs.tar.xz > ubuntu-rootfs.sha256)

echo "=== [6/6] 完成 ==="
ls -lh "${TARBALL}" "${TARGET_DIR}/ubuntu-rootfs.sha256"
echo "产物已就绪：${TARBALL}"
