# Step 7 — APK 工具链三大根因修复 + java 内置快照

## 真机验证揪出的 3 个叠加根因（"装了 java 还是不行"的真相）

1. **java 没内置**：openjdk-21 单包 106MB，此前「按需安装」设计，每次现场 apt 下 193MB。
2. **`user.home` 死锁 Termux 路径**：openjdk 编译期硬编码 `/data/data/com.termux/files/home`，不读 HOME env → apktool 建 framework 目录失败。
3. **`java.io.tmpdir` 死锁 Termux 路径**：同样硬编码 `/data/data/com.termux/files/usr/tmp` → apktool b 的 `createTempFile` 失败。

2/3 同病：Termux 的 openjdk 把路径硬编码成 `com.termux`，而 app 域实际是 `com.dsharnessmobile.shell`。

## 修复

### A. java 内置快照（`scripts/build-snapshot-013.mjs`）

TARGETS 追加 `openjdk-21` + `apksigner` + `aapt2`（BFS 只拉硬依赖 7 个，不拉 recommends）。build-snapshot 第 4 步解析 postinst 的 `update-alternatives --install` 行自动建 java/javac/keytool 链接（前缀改写），无需手动补。apktool/jadx 仍走 assets 内置 jar，不重复入快照。

### B. Java env 修复（`plugins/dsh-android-apk-tools/src/index.js`）

新增 `javaEnv()`，给所有 java 系工具（keytool/runTool/apksigner verify）传 `JAVA_TOOL_OPTIONS`：

```js
JAVA_TOOL_OPTIONS: '-Duser.home=' + home + ' -Djava.io.tmpdir=' + home + '/tmp'
```

### C. access 回调风格 bug（`plugins/dsh-android-dev-tools/src/index.js`）

`import('node:fs')` 的回调 `access` 不带 callback 抛 TypeError，改 `import('node:fs/promises')`。

## 验证（真机完整闭环实测）

| 环节 | 结果 |
|---|---|
| apk_decompile（apktool 反编译）| Apktool 3.0.3，classes.dex/manifest/resources 全解出 |
| apk_build_sign（重打包 + 签名）| 产出 out.apk（37573 字节）|
| apk_info（验签）| packageName/versionCode 正确，签名 MIUI → `CN=Android Debug` |

## zipalign 缺口（诚实结论）

- 实测 out.apk 有 6 条目未 4 字节对齐（resources.arsc/png 等）——apksigner 只对齐签名块，**不对齐资源**。
- Termux 无 zipalign 包（apt-cache search 空）、Ubuntu 容器无索引、web 无 key 查源。
- 未对齐 APK 本地能装能跑（性能略降 + Google Play 拒），对本地逆向/测试可接受。
- 补法：从 Android build-tools arm64 版下载 zipalign 二进制入 assets（后续单独立项）。

## 涉及文件

- `scripts/build-snapshot-013.mjs`（TARGETS + 注释）
- `plugins/dsh-android-apk-tools/src/index.js`（javaEnv + 4 处 env）
- `plugins/dsh-android-dev-tools/src/index.js`（access）
