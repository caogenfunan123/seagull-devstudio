# Seagull DevStudio 项目文档

本项目文档面向项目新人、贡献者与集成者，覆盖系统架构、接口契约、开发指南与核心概念。文档基于仓库代码事实撰写（main @ 835efff，0.13.2-seagull），引擎端口为 fork 迁移后的 32080。

**快速链接**: [架构](./ARCHITECTURE.md) | [接口](./INTERFACES.md) | [开发者指南](./DEVELOPER_GUIDE.md)

---

## 核心文档

### [架构](./ARCHITECTURE.md)
系统设计、运行时形态、技术栈、组件结构与数据流。从这里开始了解系统如何运作。

### [接口](./INTERFACES.md)
`window.androidBridge` 桥协议、壳与引擎 HTTP 通道、引擎与 cordis 插件服务面、插件与页面注入面。集成或扩展此系统的参考。

### [开发者指南](./DEVELOPER_GUIDE.md)
环境搭建、构建与门禁、开发工作流、编码规范与常见任务。贡献者必读。

---

## 模块

| 模块 | 描述 | README |
|------|------|--------|
| `app/` | Android 壳（Kotlin）：快照解压、引擎进程、看门狗、WebView、ADB/授权、悬浮球、IME | [模块/app](./模块/app.md) |
| `plugins/` | cordis 插件（5 个 Seagull 纯 JS + 5 个上游 TS/前端桥） | [模块/plugins](./模块/plugins.md) |
| `scripts/` | 快照构建、注入、门禁、打包、CI 编排（node/python/pwsh） | [模块/scripts](./模块/scripts.md) |
| `vendor/` | 固化第三方插件副本（undo-savepoint、marketplace）+ PATCHES.md | [模块/plugins](./模块/plugins.md) |
| `dsh-*-termux/ui-responsive/host-web-compat` | 引擎执行器与前端注入子仓库 | [模块/plugins](./模块/plugins.md) |
| `presets/` | 海鸥 3.0 提示语源稿（运行时经插件注入） | [模块/plugins](./模块/plugins.md) |

---

## 核心概念

| 概念 | 描述 |
|------|------|
| [运行时快照](./专有概念/运行时快照与启动生命周期.md) | 内嵌 Termux rootfs（assets/snapshot.tar.xz），解压即跑；指纹/刷新/回退生命周期 |
| [授权模型](./专有概念/授权模型.md) | ADB 三道门（All Files Access + 开关 + adb pair）与 KernelSU root 通道并存 |
| [Cordis 插件与装配](./专有概念/Cordis插件与装配.md) | cordis.patch.yml 驱动装配；插件以 `@dsh-android/*` 注入 profile node_modules |
| [Ubuntu PRoot 开发者容器](./专有概念/Ubuntu-PRoot容器.md) | assets/ubuntu-rootfs 内嵌 Ubuntu 24.04，proot 启动执行工具链 |

---

## 入门指南

### 项目新人？

1. [架构](./ARCHITECTURE.md) — 了解全局
2. [核心概念](#核心概念) — 学习领域术语
3. [开发者指南](./DEVELOPER_GUIDE.md) — 搭建环境
4. [接口](./INTERFACES.md) — 桥契约与扩展点

### 需要集成/改桥？

1. [接口](./INTERFACES.md) — 桥协议与认证模型
2. [架构](./ARCHITECTURE.md) — 系统边界与数据流
3. [专有概念/授权模型](./专有概念/授权模型.md) — 授权门禁语义

### 首次贡献？

1. [开发者指南](./DEVELOPER_GUIDE.md) — 搭建、构建与门禁
2. [模块/scripts](./模块/scripts.md) — 构建链各步说明
3. [编码与 PR 规范](./DEVELOPER_GUIDE.md#编码与提交规范)

---

## 版本与生态速记

- fork 基线：上游 `kelai141/dsh-mobile-apk` 0.13.2-preview；本 fork 版本 `0.13.2-seagull`（versionCode 28），仅 arm64。
- 引擎端口：`32080`（EngineProbe.ENGINE_PORT，fork 迁移；同机本体 dsh-mobile 占 3080）。
- 品牌：Seagull DevStudio / Ubuntu ARM64 开发者运行时。
- 兄弟仓库：`dsh-shell-termux`、`dsh-client-ui-responsive`、`dsh-host-web-compat`（嵌于本仓）；`kelai141/dsh-mobile`（私有协调库，构建时直连其 Release 底座）。
