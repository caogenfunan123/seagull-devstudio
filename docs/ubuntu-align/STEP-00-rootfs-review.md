# Step 0 — rootfs 平铺静态审查

## 结论

发现并修复一个明确的根因 bug：Ubuntu rootfs 设备端「多套一层 `ubuntu-noble-aarch64/`」的根因不在壳侧 `stripTopDir`，而在 CI 重打包脚本 `inject-ubuntu-toolchain.sh`。

## 根因链

1. CI 下载的 minbase 资产 `ubuntu-noble-aarch64-pd-v4.18.0.tar.xz`（termux/proot-distro 官方）顶层是单目录 `ubuntu-noble-aarch64/`。
2. `inject-ubuntu-toolchain.sh` 解包到 `$UNPACK` 后，line 34-40 探测到顶层目录并把 `ROOTFS` 指向 `$UNPACK/ubuntu-noble-aarch64`（剥掉 distro_name），用于 chroot 注入工具链。
3. **line 101 重打包却用了 `tar -C "$UNPACK" -cJf .`**（`$UNPACK` 含 distro_name 层），而不是 `tar -C "$ROOTFS" -cJf .`。产出 tar 是双重顶层 `./ubuntu-noble-aarch64/usr/bin/bash`。
4. 壳侧 `extractTarAsset(stripTopDir=true)` 预扫取第一个顶层前缀 `.`，`resolveAssetEntry` 剥掉 `./` 后残留 `ubuntu-noble-aarch64/`，最终 `bin/bash` 落在 `.dsh/ubuntu-rootfs/ubuntu-noble-aarch64/bin/bash`，`proot-entry.sh` 的 `ROOTFS_DIR` 指向 `.dsh/ubuntu-rootfs` 找不到 `/bin/bash`，容器必挂。

## 修复

`scripts/inject-ubuntu-toolchain.sh`：

- line 101：`sudo tar -C "$UNPACK" -cJf "$OUT_TAR" .` → `sudo tar -C "$ROOTFS" -cJf "$OUT_TAR" .`
- line 30-31 注释同步更新，说明重打包必须从 `ROOTFS`（已剥 distro_name）打包，产出单层 `.` 结构。

## 验证

- `bash -n` 语法检查通过。
- 静态推演：`ROOTFS` 无论是有顶层目录（指向 `$UNPACK/ubuntu-noble-aarch64`）还是平铺（指向 `$UNPACK`），`tar -C "$ROOTFS" -cJf .` 均产出单层 `.` 结构，壳侧 stripTopDir 剥 `.` 后 `bin/bash` 正确落在 dest 根。
- 待构建部署后设备验证：`.dsh/ubuntu-rootfs/bin/bash` 落点。

## 涉及文件

- `scripts/inject-ubuntu-toolchain.sh`（修复）
