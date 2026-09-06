# Step 1 — 引入 Operit native 资产

## 完成内容

从 Operit 仓库（`operit/terminal/src/main/jniLibs/arm64-v8a/`）复制 2 个 app 域定制二进制到 seagull 的 `app/src/main/assets/native/`：

| 资产 | 大小 | 类型 | sha256 |
|---|---|---|---|
| `liboperit_proot.so` | 256864 B | ELF 动态 arm64（依赖 /system/bin/linker64，NDK r29-beta4，for Android 24） | `cb40a1ced11cee76569b4008a9e478c87883ce831152be4eb9570763b82e580d` |
| `liboperit_loader.so` | 1632 B | ELF 静态 arm64 | `f149774236db1e69b36cc1e4ed3866c7094db2eee52da0d4956aa63a9bb26929` |

## 决策记录：为什么只引入 proot + loader，不引入 bash/busybox/sudo

- **proot + loader**：必要。seagull 的 proot fallback 依赖 Termux `$PREFIX/bin/proot`（坑 38：tmp 路径/loader 硬编码 termux 路径/termux-exec 拦截三连失败），Operit 的 app 域定制版根治。
- **bash**：不必要。seagull 的 rootfs 解压走壳侧 Kotlin（`extractTarAsset`），不需要宿主侧 bash；chroot 路径走系统 toybox。
- **busybox**：不必要。rootfs 解压不依赖 busybox tar（壳侧 Kotlin 已处理）。
- **sudo**：Operit 的 `libsudo.so` 是 2 字节 `$@` 占位符，无实际功能，忽略。

## 落地位置决策

- 资产入库路径：`app/src/main/assets/native/`（约 260KB，远小于 GitHub 100MB push 限制，直接入库，不走 CI 下载）。
- 运行时解压路径：`usr/share/operit-native/{proot,loader}`（独立目录，不污染 `usr/bin`，避免覆盖 Termux 快照自带的 proot）。

## 验证

- `git check-ignore` 确认 `assets/native/` 未被 .gitignore 排除，可入库。
- `file` 确认二进制为 arm64 架构，与设备匹配。

## 涉及文件

- `app/src/main/assets/native/liboperit_proot.so`（新增）
- `app/src/main/assets/native/liboperit_loader.so`（新增）
