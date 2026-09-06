# 总体复盘 — Ubuntu 容器自包含 proot + APK 工具链 + java 内置

## 产出总览（Step 0-7）

| 步骤 | 内容 | 状态 |
|---|---|---|
| Step 0 | rootfs 平铺静态审查，修复双重顶层 bug | 完成 |
| Step 1 | 引入 Operit native 资产（proot/loader，入库）| 完成 |
| Step 2 | 壳侧解压 + exec 位（EngineManager）| 完成 |
| Step 3 | 重写 proot fallback（三处自包含）| 完成 |
| Step 4 | GPL 合规登记（THIRD_PARTY_NOTICES）| 完成 |
| Step 5 | rizin 静态 ELF rootRequired 标注 | 完成 |
| Step 6 | ubuntu_status access 回调 bug 修复 | 完成 |
| Step 7 | APK 链 java 路径硬编码修复 + java 内置快照 | 完成 |

## 核心成果

1. **rootfs 平铺根因（Step 0）**：`inject-ubuntu-toolchain.sh` 重打包用错源目录（`$UNPACK` 含 distro_name 层），一行修复（`$UNPACK` → `$ROOTFS`）根治双重顶层。
2. **自包含 proot（Step 1-3）**：Operit 预编译 proot/loader，proot fallback 不再依赖 Termux proot（坑 38）。
3. **APK 工具链三大根因（Step 7）**：java 未内置 + openjdk 编译期硬编码 user.home/java.io.tmpdir 到 Termux 路径——分别经 TARGETS 加 openjdk-21/apksigner/aapt2、javaEnv() 显式 -D 覆盖修复。
4. **合规闭环（Step 4）**：GPL-2.0 登记 + LICENSES 全文 + notices 手工段。

## 验证状态

- **真机完整闭环（Step 7 实测）**：`apk_decompile`（apktool 反编译）→ `apk_build_sign`（重打包 + apksigner 签名）→ `apk_info`（aapt2 + 验签）全通，签名 MIUI → `CN=Android Debug`。
- **ubuntu_status（Step 6 实测）**：present:true（access 修复生效）。
- **源码级**：全部脚本 `node --check` 通过。

## 遗留问题

1. **zipalign 缺失（已知缺口）**：apksigner 只对齐签名块不对齐资源，实测 out.apk 有 6 条目未对齐；Termux/Ubuntu 均无 zipalign 包，未对齐 APK 本地可装可跑（性能略降 + Google Play 拒）。后续从 Android build-tools arm64 下载补，或本地自用则无需处理。
2. **proot fallback 未真机验证**：Operit proot 的 glue rootfs/loader 行为待设备确认（次要路径，chroot 优先已够用）。
3. **rizin 非 PIE**：普通 shell 不可执行，需 root 通道；无 root 使用需自编译 PIE（单独立项）。
4. **Operit proot 源码版本不透明**：jniLibs 经 Google Drive 下载，源码要约指向 proot-me/proot + Operit 仓库。

## 下一步

1. CI 重新构建（TARGETS 变化触发快照重建，含 openjdk-21/apksigner/aapt2 常驻），取 APK 装机验证 java 开箱即用。
2. 验证点：装完直接 `java -version` / `apktool --version` 可用，无需跑 install-java-tools.sh。
