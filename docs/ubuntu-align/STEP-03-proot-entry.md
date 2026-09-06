# Step 3 — 重写 proot fallback 分支

## 完成内容

三处 `proot-entry.sh` / 启动器的 fallback 分支，从 Termux proot/loader 切换为自包含 Operit proot/loader：

| 文件 | 改动 |
|---|---|
| `EngineManager.kt` writeProotEntry | `prootBin`/`loaderBin` 指向 `usr/share/operit-native/{proot,loader}`；fallback 删 `U=...%/bin/proot` 推导与 `PROOT_LOADER_32` |
| `scripts/launch_ubuntu_proot.sh` | `PROOT_BIN` → `${PREFIX}/share/operit-native/proot`；`PROOT_LOADER` 显式指向 operit-native/loader |
| `scripts/build-ubuntu-rootfs.sh` heredoc | `PROOT_BIN`/`PROOT_LOADER` 默认值改为 operit-native 路径 |

## 关键保留

- **保留 `unset LD_PRELOAD TERMUX_EXEC__*`**：引擎进程继承 termux-exec 的 LD_PRELOAD 拦截，即使换成 Operit proot 仍需清理，否则 guest 路径被改写成宿主 PREFIX。
- **保留 `PROOT_TMP_DIR`**：坑 35 修复，Operit proot 同样需要显式 tmp（app 域无编译期 Termux tmp）。

## 验证

- `bash -n` 三脚本语法检查全过。
- 读回 `writeProotEntry` 确认 `prootBin`/`loaderBin` 落位正确，`PROOT_LOADER` 显式指向 operit-native/loader。

## 涉及文件

- `app/src/main/java/com/dshmobile/shell/EngineManager.kt`
- `scripts/launch_ubuntu_proot.sh`
- `scripts/build-ubuntu-rootfs.sh`
