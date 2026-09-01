#!/bin/bash
# ==============================================================================
# setup_fake_sysdata.sh - 伪造受限 /proc 与 /sys 节点（与 Operit 机制完全一致）
# ==============================================================================
set -eu

UBUNTU_ROOT="${1:-/data/data/com.dsharnessmobile.shell/files/home/.dsh/ubuntu-rootfs}"

mkdir -p "${UBUNTU_ROOT}/proc" "${UBUNTU_ROOT}/sys" "${UBUNTU_ROOT}/sys/.empty"
chmod 755 "${UBUNTU_ROOT}/proc" "${UBUNTU_ROOT}/sys"

if [ ! -f "${UBUNTU_ROOT}/proc/.loadavg" ]; then
    cat <<- 'EOF' > "${UBUNTU_ROOT}/proc/.loadavg"
    0.12 0.07 0.02 2/165 765
EOF
fi

if [ ! -f "${UBUNTU_ROOT}/proc/.stat" ]; then
    cat <<- 'EOF' > "${UBUNTU_ROOT}/proc/.stat"
    cpu  1957 0 2877 93280 262 342 254 87 0 0
    cpu0 31 0 226 12027 82 10 4 9 0 0
    cpu1 45 0 664 11144 21 263 233 12 0 0
    cpu2 494 0 537 11283 27 10 3 8 0 0
    cpu3 359 0 234 11723 24 26 5 7 0 0
    intr 127541 38 290 0 0 0 0 4 0 1 0 0
    ctxt 140223
    btime 1680020856
    processes 772
    procs_running 2
    procs_blocked 0
EOF
fi

if [ ! -f "${UBUNTU_ROOT}/proc/.uptime" ]; then
    cat <<- 'EOF' > "${UBUNTU_ROOT}/proc/.uptime"
    3456.78 27654.32
EOF
fi

if [ ! -f "${UBUNTU_ROOT}/proc/.version" ]; then
    cat <<- 'EOF' > "${UBUNTU_ROOT}/proc/.version"
    Linux version 6.1.0-seagull-arm64 (gcc 13.2.0) #1 SMP PREEMPT
EOF
fi

echo "[Seagull] Fake sysdata initialized at ${UBUNTU_ROOT}"
