#!/bin/bash
# ==============================================================================
# launch_ubuntu_proot.sh - Ubuntu 容器启动器（root chroot 优先，proot fallback）
# 兼容 Android 8.0 - 15；有 KernelSU/Magisk su 时直接用 root chroot，绕开 proot。
# ==============================================================================
PREFIX="${PREFIX:-/data/data/com.dsharnessmobile.shell/files/usr}"
HOME_DIR="${HOME:-/data/data/com.dsharnessmobile.shell/files/home}"
UBUNTU_ROOT="${HOME_DIR}/.dsh/ubuntu-rootfs"
PROOT_BIN="${PREFIX}/bin/proot"

if [ ! -d "${UBUNTU_ROOT}" ]; then
    echo "[Seagull Error] Ubuntu rootfs not found at ${UBUNTU_ROOT}"
    exit 1
fi

# 提取命令：兼容 `-lc CMD`（ubuntu_exec 默认）与直接 `CMD...`。
if [ "${1:-}" = "-lc" ] || [ "${1:-}" = "-c" ]; then
    CMD="${2:-}"
else
    CMD="$*"
fi

# ---- Root chroot 路径（KernelSU/Magisk su 可用时）----
if [ -x /system/bin/su ]; then
    CMD_B64="$(printf '%s' "$CMD" | base64 | tr -d '\n')"
    exec /system/bin/su -c "export PATH=/system/bin:/system/xbin:/system/usr/bin; export LD_LIBRARY_PATH=/system/lib64:/system/lib; export LD_PRELOAD=; R='$UBUNTU_ROOT'; mount -t proc proc \"\$R/proc\" 2>/dev/null; mount -t sysfs sys \"\$R/sys\" 2>/dev/null; mount -o bind /dev \"\$R/dev\" 2>/dev/null; mount -t devpts devpts \"\$R/dev/pts\" 2>/dev/null; [ -s \"\$R/etc/resolv.conf\" ] || printf 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n' > \"\$R/etc/resolv.conf\"; C=\$(printf '%s' '$CMD_B64' | base64 -d 2>/dev/null); exec chroot \"\$R\" /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TERM=xterm LANG=C.UTF-8 /bin/bash -lc \"\$C\""
fi

# ---- proot fallback ----
# 初始化虚假 sysdata（Android 内核 /proc/stat 缺桌面字段，容器内 nproc/ps/CMake 会读 0 核）
"${HOME_DIR}/.dsh/scripts/setup_fake_sysdata.sh" "${UBUNTU_ROOT}" 2>/dev/null || true
# proot 默认用编译期 Termux tmp（/data/data/com.termux/...）建 glue rootfs，app 域不存在 → 必须显式指定
export PROOT_TMP_DIR="${TMPDIR:-$HOME_DIR/tmp}"
mkdir -p "$PROOT_TMP_DIR"
# proot 硬编码 termux loader 路径（/data/data/com.termux/...），app 域不存在 → 用 PROOT_LOADER 覆盖
U="${PROOT_BIN%/bin/proot}"
export PROOT_LOADER="$U/libexec/proot/loader"
export PROOT_LOADER_32="$U/libexec/proot/loader32"
# 清理 termux-exec 的 execve 拦截（会把 guest 路径改写成宿主 PREFIX 路径，导致 proot execve 失败）
unset LD_PRELOAD TERMUX_EXEC__EXECVE_CALL__INTERCEPT TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE TERMUX_EXEC__PROC_SELF_EXE

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
