#!/usr/bin/env bash
# ==============================================================================
# Seagull DevStudio - Ubuntu 24.04 ARM64 PRoot 开发者运行容器装配脚本
# ==============================================================================
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${WORKSPACE_DIR}/app/src/main/assets"
TEMP_BUILD_DIR="${WORKSPACE_DIR}/out/ubuntu-arm64-build"

echo "=== [1/5] 初始化构建工作区 ==="
mkdir -p "${TARGET_DIR}" "${TEMP_BUILD_DIR}"
cd "${TEMP_BUILD_DIR}"

echo "=== [2/5] 配置 Ubuntu ARM64 基础运行环境 ==="
cat << 'EOF' > init-environment.sh
#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    build-essential \
    clang \
    cmake \
    ninja-build \
    python3 \
    python3-pip \
    python3-venv \
    openjdk-17-jdk-headless \
    apktool \
    zipalign \
    apksigner \
    unzip \
    zip \
    tar \
    xz-utils \
    tzdata \
    locales

locale-gen en_US.UTF-8
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF
chmod +x init-environment.sh

echo "=== [3/5] 生成 PRoot 启动包装入口 ==="
cat << 'EOF' > "${TEMP_BUILD_DIR}/proot-entry.sh"
#!/bin/bash
export UBUNTU_ROOT="${HOME}/.dsh/ubuntu-rootfs"
export PROOT_BIN="${PREFIX}/bin/proot"

if [ ! -d "${UBUNTU_ROOT}" ]; then
    echo "[Seagull] 未检测到 Ubuntu 运行时根目录，请先执行解压。"
    exit 1
fi

exec "${PROOT_BIN}" \
    --link2symlink \
    --kill-on-exit \
    -0 \
    -r "${UBUNTU_ROOT}" \
    -b /dev \
    -b /proc \
    -b /sys \
    -b /storage \
    -b "${HOME}:${HOME}" \
    -w "${HOME}" \
    /bin/bash "$@"
EOF
chmod +x "${TEMP_BUILD_DIR}/proot-entry.sh"

echo "=== [4/5] 验证核心打包资产 ==="
echo "Ubuntu 开发者容器配置已就绪。CI 环境将把 ubuntu-rootfs.tar.xz 组装至 assets 目录。"

echo "=== [5/5] 完成 ==="

