# Step 6 — ubuntu_status access 回调风格 bug（真机验证发现）

## 现象

覆盖安装后真机验证：`gcc --version` / `ls /bin/bash` 均正常（rootfs 平铺已生效），但 `ubuntu_status` 恒报 `present:false`（缺 usr/bin/bash），与容器实际可用矛盾。

## 根因

`plugins/dsh-android-dev-tools/src/index.js` 的 `ubuntu_status`：

```js
const { access } = await import('node:fs');        // 回调风格
const { stat } = await import('node:fs/promises'); // Promise 风格
...
await access(bash);   // 不带 callback → 抛 TypeError: The "cb" argument must be of type function
```

`node:fs` 的 `access` 是回调风格，不带 callback 会抛 `TypeError`，被 `catch` 误判为「文件不存在」，恒返回 present:false。本机实测 `node -e "require('fs').access('/etc/hosts')"` 确认抛 `The "cb" argument must be of type function. Received undefined`。

## 修复

```js
const { access, stat } = await import('node:fs/promises');
```

access 与 stat 统一走 Promise 风格。

## 验证（本机实测）

1. 本机热修 `profiles/web/node_modules/@dsh-android/dsh-android-dev-tools/lib/index.js`。
2. Node 模拟修复后逻辑：`RESULT: present:true bashBytes:1543048`。
3. 重启引擎（看门狗自愈，PID 15213→20039），`ubuntu_status` 返回 `{ok:true, present:true, bashBytes:1543048}`。

## 涉及文件

- `plugins/dsh-android-dev-tools/src/index.js`（1 处）
