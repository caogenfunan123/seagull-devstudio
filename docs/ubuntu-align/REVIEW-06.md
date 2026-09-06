# Review 6 — ubuntu_status access bug 复盘

## 结果 vs 预期

- 预期：容器验证全绿。
- 实际：容器本身（gcc/bash/平铺）全绿，但 `ubuntu_status` 误报 false——暴露 access 回调风格 bug，已修复并真机验证 present:true。

## 教训

`node:fs` 与 `node:fs/promises` 混用是高频雷：同步/回调 API 不带 callback 会抛 TypeError，被 try/catch 吞成「假失败」。全插件扫描确认仅此一处误用（其余 import('node:fs') 均为同步函数 mkdirSync/rmSync 等）。

## 验证闭环

- 本机热修 lib + Node 实测逻辑 + 重启引擎 + `ubuntu_status` 工具返回 present:true，三步闭环。

## 下一步

提交 access 修复，推送，触发 CI 重新构建（让正式 APK 包含此修复）。
