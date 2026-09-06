# Review 3 — proot fallback 重写复盘

## 结果 vs 预期

- 预期：三处 fallback 从 Termux proot 切到自包含 Operit proot/loader，保留 termux-exec 清理。
- 实际：三处同步完成，语法检查全过。`PROOT_LOADER_32` 删除（Operit 无 32 位 loader，且 arm64-only fork 不需要）。

## 遗留问题

- Operit proot 的运行时行为（glue rootfs、loader 加载）未真机验证，需构建部署后确认 fallback 分支真正可用。
- 根因修复（Step 0）后 chroot 优先路径已够用，proot fallback 是次要路径，验证优先级低于主路径。

## 下一步

Step 4：GPL 合规登记（proot/loader 来源 + 源码要约）。
