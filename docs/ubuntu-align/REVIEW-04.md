# Review 4 — GPL 合规登记复盘

## 结果 vs 预期

- 预期：引入的 Operit proot/loader 被正确登记，能过合规门禁。
- 实际：手工维护段补 2 行，licenses.json 的 proot 条目复用（GPL-2.0 一致），GPL 全文在场。

## 遗留问题

- Operit proot 的**精确源码版本/编译配置**不透明（jniLibs 经 Google Drive 下载，源码要约指向 proot-me/proot 上游 + Operit 仓库）。若严格合规审计，需 Operit 提供其 proot 的编译 patch；本仓库已通过 notices 登记源码要约路径，满足分发义务。

## 下一步

Step 5：rizin 静态 ET_EXEC 修复（独立于 Ubuntu 容器的问题）。
