# Step 5 — rizin 静态 ELF 修复

## 根因

rizin 官方 android-aarch64 资产（`rizin-v0.7.4-android-aarch64.tar.gz`，installer 格式）是**静态非 PIE ET_EXEC**（e_type:2）。Android 8+ 的 `/system/bin/linker64` 拒绝加载非 PIE ET_EXEC（报 `has unexpected e_type: 2`），故在普通 Termux shell 不可执行。root 通道（`root_exec` 干净环境）可正常加载（已验证 rizin 0.7.4 输出）。

这是上游资产的限制，不是 seagull 的 bug；换 PIE 构建需自编译（meson + NDK），成本高且 rizin 编译链复杂。

## 修复（务实方案）

`plugins/dsh-android-tool-installer/src/index.js`：

1. rizin registry 加 `rootRequired: true`，description 注明非 PIE 限制。
2. `tool_install` 成功且目标工具 `rootRequired` 时，返回附加 `note` 提示走 root 通道执行。

## 效果

用户 `tool_install rizin` 后得到明确提示「非 PIE 静态构建，Android 8+ 需经 root 通道（root_exec）执行」，不再「装了跑不起来不知道为什么」。radare2（动态 PIE）不受影响，普通 shell 可用。

## 验证

- `node --check` 语法通过。

## 涉及文件

- `plugins/dsh-android-tool-installer/src/index.js`（2 处）
