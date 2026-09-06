# Review 1 — native 资产引入复盘

## 结果 vs 预期

- 预期：把 Operit 的 proot/loader 资产落位到 seagull，记录来源与 hash。
- 实际：2 个二进制复制完成，sha256 已记录，架构（arm64）与设备匹配，assets/native 可入库。

## 遗留问题

- GPL 合规登记（proot 的源码要约 + license 声明）在 Step 4 统一处理。
- 资产尚未接入壳侧解压逻辑（Step 2）。

## 下一步

Step 2：壳侧 `EngineManager.extractToolAssets` 增加 native 资产复制 + exec 位。
