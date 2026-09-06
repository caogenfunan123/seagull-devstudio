# Step 2 — 壳侧解压 + exec 位

## 完成内容

`EngineManager.kt` 三处改动，落地自包含 proot 资产：

1. **新增字段**（line 24-25）：`operitNativeDir = File(usrDir, "share/operit-native")`，独立目录，不污染 Termux 快照的 `usr/bin`。
2. **幂等检查纳入 native 资产**（line 204-209）：`operitProot`/`operitLoader` 加入跳过条件，确保升级设备（已有 apkJar/prootEntry/rootfsBash 但缺新 native 资产）会触发补部署，而不是被幂等短路跳过。
3. **复制 + exec 位**（line 220-225）：`copyAssetToFile("native/liboperit_proot.so", operitProot)` 等，复制后 `setExecutable(true, false)`。

## 关键设计

- 资产名 `liboperit_proot.so`/`liboperit_loader.so` 复制后改名为 `proot`/`loader`（去 lib 前缀和 .so 后缀），供 `proot-entry.sh` 直接以可执行名引用。
- `copyAssetToFile` 本身不设 exec 位（它面向 jar/tar），故复制后显式 `setExecutable`。

## 验证

- 读回改动确认字段/幂等/复制三处落位正确，Kotlin 语法无误。

## 涉及文件

- `app/src/main/java/com/dshmobile/shell/EngineManager.kt`（3 处）
