# Review 7 — APK 链修复 + java 内置复盘

## 结果 vs 预期

- 预期：APK 逆向/打包链开箱即用。
- 实际：反编译/重打包/签名/验签完整闭环真机跑通；根因是 3 个叠加问题（java 未内置 + user.home + tmpdir 两个 openjdk 硬编码），均已修。

## 修正

本轮修正了我此前的一个错误判断：「zipalign 非必需（apksigner 兜底）」——实测 out.apk 有 6 条目未对齐，apksigner 不对齐资源。zipalign 确实需要，但 Termux/Ubuntu 均无包，未对齐本地可接受，列入已知缺口。

## 遗留

1. **zipalign**：从 Android build-tools arm64 下载入 assets（后续单独立项）。
2. **install-java-tools.sh**：openjdk-21 入快照后，此安装器降级为兜底（正常不再需要跑），可后续精简 PKGS。

## 下一步

等用户通知后提交（build-snapshot TARGETS + apk-tools javaEnv + dev-tools access + 文档）并推送触发 CI。
