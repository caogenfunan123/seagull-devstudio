#!/bin/bash
# ==============================================================================
# launch_ubuntu_proot.sh - 标准 PRoot 启动器（兼容 Android 8.0 - 15）
# ==============================================================================
set -eu

PREFIX="${PREFIX:-/data/data/com.dsharnessmobile.shell/files/usr}"
HOME_DIR="${HOME:-/data/data/com.dsharnessmobile.shell/files/home}"
UBUNTU_ROOT="${HOME_DIR}/.dsh/ubuntu-rootfs"
PROOT_BIN="${PREFIX}/bin/proot"

if [ ! -d "${UBUNTU_ROOT}" ]; then
    echo "[Seagull Error] Ubuntu rootfs not found at ${UBUNTU_ROOT}"
    exit 1
fi

# 初始化虚假 sysdata
"${HOME_DIR}/.dsh/scripts/setup_fake_sysdata.sh" "${UBUNTU_ROOT}" 2>/dev/null || true

exec "${PROOT_BIN}" \
    --link2symlink \
    --kill-on-exit \
    -0 \
    -r "${UBUNTU_ROOT}" \
    -b /dev \
    -b /proc \
    -b /sys \
    -b "${UBUNTU_ROOT}/proc/.stat:/proc/stat" \
    -b "${UBUNTU_ROOT}/proc/.loadavg:/proc/loadavg" \
    -b "${UBUNTU_ROOT}/proc/.uptime:/proc/uptime" \
    -b "${UBUNTU_ROOT}/proc/.version:/proc/version" \
    -b /storage \
    -b "${HOME_DIR}:${HOME_DIR}" \
    -w "${HOME_DIR}" \
    /bin/bash "$@"
