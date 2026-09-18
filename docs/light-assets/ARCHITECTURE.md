# Seagull DevStudio 资产与工具链基础架构（轻资产防坏版）

> 2026-09-18 轻资产化改造收口文档。参考 DSHA（176MB 离线 APK）的构建期锁哈希 / 原子写 / lstat stamp 范式，
> 结合本 fork「真机 + root + 有网」形态落地。方案与执行记录见同目录 PLAN.md，坑号见 AGENTS.md §6（坑 44-45）。

## 1. 总体形态

```
┌─ APK（arm64，目标 ~360M）────────────────────────────────┐
│ Android 壳（Kotlin，com.dsharnessmobile.shell）           │
│   ├─ assets/snapshot.tar.xz      Termux 运行时+引擎 ~271M │
│   ├─ assets/snapshot.sha256      快照指纹（Freshness 链）  │
│   ├─ assets/asset-manifest.json  资产防坏清单（构建期生成）│
│   ├─ assets/tools/apktool.jar    唯一随包工具 ~22M        │
│   ├─ assets/native/liboperit_*.so 自包含 proot/loader 入库│
│   └─ assets/ubuntu-rootfs.tar.xz minbase 原样 ~65M        │
└──────────────────────────────────────────────────────────┘
```

体量账：旧 721M = 271(snapshot) + 299(qemu 注入工具链版 rootfs) + 152(jadx/r2/rizin) − 压缩重叠。
新 ≈ 271 + 65 + 22 ≈ 360M 级。工具链与三个重工具转在线/按需。

## 2. 构建期资产流水线（gen-asset-manifest.mjs 为闸心）

```
build-apk.yml                          build-apk.mjs
  │ 下载 apktool.jar + minbase rootfs     │
  │ (jadx/r2/rizin 不再下载)              │
  │        └──────────────────────────────┤
  │   snapshot.tar.xz 就位 → snapshot.sha256 │
  │   gradle 前强制：node scripts/gen-asset-manifest.mjs
  │        │  扫描 app/src/main/assets/：
  │        │   assets{}   — 逐字节 copy 项本体 sha256
  │        │               (apktool.jar、operit proot/loader)
  │        │   probes{}   — rootfs 关键成员（bash/apt/os-release/resolv.conf）
  │        │               从归档流式抽取算 sha256；软链成员=链接目标串哈希；
  │        │               键=「剥离顶层目录后的落点相对路径」
  │        │   rootfsStats— members = 规范化落点去重数（非 tar 成员数，坑 45）
  │        │               fileBytes = 常规文件字节和（软链/目录 0）
  │        ▼
  │   asset-manifest.json（.gitignore：钉的是下载资产哈希，入库必陈旧）
  │        ▼
  │   gradle assembleDebug → APK
```

本地裸 gradle（无清单）不会误入核验链：清单缺失 → 壳侧走 legacy exists 路径（见 §3），
开发迭代不被构建期产物绑架。

## 3. 运行期落地链（EngineManager.extractToolAssetsLocked）

```
startEngine（MainActivity/EngineService 并发进入，TOOL_EXTRACT_LOCK 单飞）
  │
  ├─ loadAssetManifest() == null ──► extractToolAssetsLegacy()（旧式 exists 语义）
  │
  ├─ stamp 判定：.toolassets-stamp == sha256(清单哈希 + 资产哈希聚合 + APK identity
  │              path:len:mtime)  且  锚点（仅按 APK 内实际在场资产推导）全存在
  │     命中 → 直接返回（每次启动 O(1)）
  │
  └─ 重解路径（首启 / 换包 / 校验失败自愈）：
       1) staging：files/.toolassets-staging 下全量落地
            copyAssetToStaged：写 .part 再 rename（原子）
            extractTarAsset(rootfs, stripTopDir)：dir/symlink/file 三类处理，
              symlink 越界防护、exec 位保留（bin->usr/bin 顶层软链不可丢）
            writeProotEntry：rootfs 根下 proot-entry.sh + fake sysdata
       2) 核验（任一失败 = 抛，staging 全弃，stamp 永不写 → 下次重解）：
            verifyAssetHashes：清单有项 → 落点必在且哈希必符（放过缺失=重解风暴，坑 45）
            verifyRootfs：walk 计数/字节 对清单取**下界**（壳侧附加落地只会抬高，
              不能用相等，坑 45 同源）+ probes 逐成员哈希
       3) promoteTree(stUsr→usrDir, stHome→homeDir)：
            **逐路径递归合并**——目录双方存在→递归；仅 staging 有→rename；
            文件/软链→deleteForOverwrite→rename（EXDEV 退 verified copy）。
            绝不整目录顶替：usr/share、home/.dsh 下混有快照引擎树与用户数据。
       4) 成功才 writeText(stamp)——崩溃窗口分析见 PLAN.md §5
```

与 DSHA 对照：writeIfChanged 的 `.dsha-tmp` staging + Os.rename 原子替换、lstat stamp
（dev:inode:size:mtime 集 + APK identity）、构建期 packages.lock.json 锁哈希——范式同构；
本 fork 保留 root 真机在线通道（apt/tool_install），不搬 DSHA 的零网络双 flavor 约束。

## 4. 在线安装链（tool-installer，轻资产时代的"主供应链"）

```
registry install 语义：
  built-in (apktool)  — 随 APK，壳侧解压，tool_install 仅兜底
  online   (jadx/r2/rizin) — 必走网络：download → sha256 校验 → 解压(stripComponents)

下载候选链（P3）：
  直连 GitHub → https://ghfast.top/<原 URL>（公益前缀代理，国内加速）
              → DSH_MIRROR_PREFIX env（逗号分隔多前缀，域名可换，无 SLA 故可配）
  仅 github.com/objects.githubusercontent.com/codeload 生效（bitbucket 前缀代理不支持）
  切源即删残档 + 进度复位；**sha256 期望值永远来自内置 TOOL_REGISTRY，
  绝不跟下载源走**——镜像投毒即校验拒收（同 build-snapshot 的 npmmirror 双镜像思路）。

ubuntu_toolchain_install（dev-tools，P2 配套）：
  探测 /system/bin/su 可执行 → proot-entry.sh 自动走 root chroot 路线：
    apt-get update && apt-get install -y --no-install-recommends
      build-essential cmake git python3（+ 可选包名，白名单字符闸 + 逐项 shQuote 防注入）
  无 root → 如实拒绝（纯 proot 下 dpkg 触发 SYSCONFDIR 沙箱限制，坑 13/38），
  引导走宿主 install-java-tools.sh。timeout 900s，apt 幂等可重跑。
```

## 5. 消费端衔接

- apk-tools（宿主 Java 链）：wrapper 优先 → `usr/share/jadx/lib/jadx-1.5.0-all.jar`
  classpath 兜底。在线装 jadx 解到同一路径（zip 顶层即 `lib/`，实测 9 条目），两条链无缝。
- dev-tools ubuntu_exec/ubuntu_status：rootfs 落点契约不变（`.dsh/ubuntu-rootfs/bin/bash`
  marker）；minbase 开箱缺 gcc 由 toolchain_install 补，ubuntu_status 报 present。
- 升级路径：覆盖安装 → APK identity 变 → stamp 失配 → 全量重解 + 核验；失败不写 stamp
  自愈重试（坑 40 的 deleteForOverwrite 已在 promote/清理路径内）。

## 6. 不变量清单（改动此链前必读）

1. 完成判定 = stamp + 在场锚点，二者缺一即重解；**永远不用裸 exists() 判装配完成**（坑 44）。
2. 清单 members 的口径 = 规范化落点去重数，与壳侧 walkTopDown（排除 root 自身）严格同构（坑 45）。
3. rootfs 核验只取下界（`<` 判失败）；相等判定会被壳侧附加落地（proot-entry + fake sysdata）假失败。
4. promote 必须逐路径合并；任何"整目录替换"实现都是数据炸弹（引擎树 + 用户数据同树混存）。
5. sha256 期望值的唯一来源是构建期入源的注册表（TOOL_REGISTRY / asset-manifest），
   下载源永远不可信；镜像只是带宽手段，不是信任边界。
6. asset-manifest.json 与它钉哈希的资产同属"构建期生成物"，三者（tools/、ubuntu-rootfs、
   manifest）一律不入库、由 CI 同步骤产生，防止陈旧漂移。
