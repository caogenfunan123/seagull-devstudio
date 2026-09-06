# Review 2 — 壳侧解压复盘

## 结果 vs 预期

- 预期：壳侧把 native 资产复制到独立目录并设 exec 位，纳入幂等检查。
- 实际：三处改动完成，读回验证正确。幂等检查补齐避免了「升级设备缺新资产」被短路跳过的隐患。

## 遗留问题

- `copyAssetToFile` 对缺失资产静默 `return`（`if (!hasAsset(asset)) return`），若 CI 漏打包 native 资产，壳侧不报错，仅 proot fallback 仍回退 Termux。需在构建后验证资产确实进 APK。

## 下一步

Step 3：重写 `proot-entry.sh` 的 fallback 分支，改用 `usr/share/operit-native/proot` + `PROOT_LOADER`。
