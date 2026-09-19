# 轻资产化 + 工具链防坏改造方案（2026-09-18）

> 状态：执行中。每完成一阶段在本文档登记，并同步 AGENTS.md 更新记录表。
> 参考项目：github.com/DSH-APP/DSHA（176MB APK，split-runtime-v1 + writeIfChanged 原子写 + lstat stamp 身份 + 构建期锁哈希）。
> 原则：以 Seagull fork 为主（root 真机 + 有网场景），只借鉴 DSHA 的机制，不引入其双 flavor/零网络约束。

## 0. 现状与根因

721MB APK 构成：Termux 快照 271M + ubuntu-rootfs（qemu 注入编译工具链版）299M + tools（jadx 105M/radare2/rizin/apktool）154M。

工具链"解压老是坏"三根因（对照 DSHA 实锤）：
1. 完成判定只看 5 个文件 exists()（EngineManager.extractToolAssetsLocked）——半坏永久定格；
2. 落地写无原子性（deleteIfExists 后直接流式写目标路径）——中断即留半份；
3. assets 解压后零校验（sha256 只覆盖 tool-installer 网络下载面）。

已知未愈：extractZipAsset 丢可执行位（jadx 官方 zip 的 bin/jadx 脚本不能直跑，此前用 java -cp 绕行）。

## 1. P1 防坏（最高优先）

- [x] `scripts/build-apk.mjs`：gradle 前生成 `app/src/main/assets/asset-manifest.json`——
      asset 文件本体 sha256（ubuntu-rootfs.tar.xz / apktool.jar / native/*.so / operit 对）+
      rootfs 关键落点（bin/bash）解包抽检 sha256。snapshot 已有 snapshot.sha256 指纹体系，不重复。
- [x] `EngineManager.extractToolAssetsLocked` 重写：staging 目录解压 → manifest 抽检 →
      逐目录/文件原子 rename 到目标 → 写 `.toolassets-stamp`（APK identity(path:len:mtime) + manifest sha256）。
      判定从「exists」换成「stamp 匹配」；不匹配 → 删残留重解。
- [x] `extractZipAsset` 移除非用路径：jadx/radare2/rizin 改在线安装后该函数无调用者，整体删除
      （exec 位丢失缺陷随在线安装的 tar/unzip 天然规避——在线装走 extractArchive，不走已删的 zip 解压器）。
- [x] 全程防半份：任何中断后 stamp 不写 → 下次启动重解，不出现「解一半判成功」。

## 2. P2 轻资产

- [x] ubuntu-rootfs 换 minbase 原样（proot-distro 官方 arm64，~65M）：CI 不再 qemu 注入工具链（省 ~234M）。
      开箱仍有 bash/apt 潜力；root chroot 路线不变（坑 38）。
- [x] 编译工具链改设备端按需安装：dev-tools 新工具 `ubuntu_toolchain_install`——
      root chroot 内 `apt-get install -y build-essential cmake git python3`（真机实测 chroot+apt 全绿，坑 38），
      无 root 时如实报「受限（dpkg SYSCONFDIR，坑 13）」。
- [x] jadx/radare2/rizin 移出 APK（省 ~152M）：tool-installer 在线装通道已存在（sha256 内置），
      从「内置回退」改「在线为主」；apktool（22M）留 APK（体积小、使用频度高）。
- [x] CI 移除 assets/tools 的 jadx/r2/rizin 下载步骤与 inject-ubuntu-toolchain 调用；产物单 APK（预计 ~360M）。
- [x] 已知缺口的文档同步：§9 内置工具资产段、tool-installer/apk-tools/EngineManager 顶部注释。
      （README 无资产明细段，无需改动。）

## 3. P3 下载镜像链

- [x] tool-installer `downloadFile`：GitHub 直连失败 → `https://ghfast.top/` 前缀重试 → 支持
      配置项 `DSH_MIRROR_PREFIX` 覆盖（公益镜像无 SLA，域名可换）。
- [x] sha256 期望值仅来自内置 registry（绝不跟下载源走），镜像被投毒即校验拒收。
- [x] 与 build-snapshot 的 npmmirror 双镜像链同构，文档注明。

## 4. 验证矩阵（推送前必须全绿）

- 本地：node --check 全脚本；6 JS 包 install+build；ui-responsive 测试；check-contract / check-patch-mounts / smoke-bridge；
  manifest 生成脚本对样例 rootfs 实测；纯 JS 逻辑（镜像链 URL 变换、manifest 解析）配 mock 跑通。
- Kotlin：本地无 Android SDK，走独立分支 push + PR 触发 pr-gate（compileDebugKotlin）验证，绿后 merge main。
  （实际执行注：PR gate 因账户 Actions 计费阻断无法起跑，改沙箱装 SDK 36 本地实跑
  `./gradlew :app:compileDebugKotlin` 等效验证——BUILD SUCCESSFUL，见复盘第三轮。）
- CI：pr-gate 绿 → build-apk 盯到 success，Release 产物核对体积。

## 5. 风险与对策

- 升版后设备旧工具资产：stamp 不含旧身份 → 首次启动自动重解（幂等，坑 40 的 deleteForOverwrite 已具备目录/软链混用清理）。
- minbase 无 python3：ubuntu_exec 常用命令子集不受影响；需要 python 的用户走 ubuntu_toolchain_install（含 python3）。
- ghfast.top 不可达：镜像链自动回退直连；两者都失败给出手动镜像配置提示。
- 在线工具链首装耗时：进度走 tool_status 状态机，中断可重跑（apt 幂等）。

## 6. 复盘记录

### 执行登记（2026-09-18）

- P1：`gen-asset-manifest.mjs` 新增并接入 `build-apk.mjs`（gradle 前强制生成）；`EngineManager.kt`
  extractToolAssetsLocked 重写（staging→核验→promoteTree→stamp），legacy exists 路径保留给无清单裸构建；
  extractZipAsset 随 jadx 出包整体删除（无引用，grep 实锤）。
- P2：`build-apk.yml` 资产步骤改「apktool + minbase 原样」，移除 jadx/r2/rizin 下载与 inject-ubuntu-toolchain
  调用（脚本保留供本地手动重建 rootfs）；dev-tools 新增 `ubuntu_toolchain_install`；
  tool-installer registry 语义 built-in/online 化；apk-tools/EngineManager 注释与引导文案同步；
  asset-manifest.json 入 .gitignore（钉下载资产哈希，入库必陈旧）。
- P3：`candidateUrls`/`downloadWithMirrors` 上线（直连→ghfast.top→DSH_MIRROR_PREFIX），
  sha256 期望值锁定内置 registry（镜像不构成信任边界）。

### 复盘第一轮（静态全量 diff 审查）——发现并修复 3 处

1. **verifyAssetHashes 放过缺失项**（早期 `if (dest.exists() && hash!=…)`）：清单有项=打包时资产必在场，
   落点缺失若不抛 → stamp 照写但锚点永不满足 → 每启动全量重解。已改为缺失即抛。
2. **幂等锚点硬编码全量**：清单在但个别资产缺（协调库本地构建）同样引爆重解风暴。已改为按
   `hasAsset()` 在场推导锚点。
3. **假 rootfs 双向往返测试实锤 members 口径错位**（tar 成员 9 vs 壳侧 walk 8：顶层目录剥离后不落地 +
   tar 允许重复条目）：真 rootfs ~17k 成员下重复条目会把完整解压误判半份、永不收敛。
   已改清单按规范化落点去重计数，与 walkTopDown 严格同构（登记坑 45）。

### 复盘第二轮（行为仿真 + 门禁复跑）

- 假 rootfs：archive 侧 probes 与解包 FS 侧（含软链=目标串哈希）逐项相等；members/fileBytes
  与 walk 逐一对账（8/8、39/39）；删一文件 → 7 < 8 下界捕获（半份必重解）。PASS。
- dev-tools mock ctx：3 工具全注册、parameters 扁平 map（坑 33 合规）；无 root 环境 execute
  走如实降级（rootRequired:true，不静默假成功，坑 13/37 合规）；packages 注入串实测：
  `;`/`$()`/反引号/`/` 全部白名单丢弃，幸存 token 均单引号包裹（rm 作为引号内 apt 参数无执行语义）。PASS。
- tool-installer mock ctx：4 工具注册 + install 语义展示面无消费者依赖旧 'auto' 值（grep 全仓无判定方）。PASS。
- candidateUrls：github 三域命中镜像、bitbucket 不命中、DSH_MIRROR_PREFIX 逗号多前缀生效（源码函数直测）。PASS。
- 门禁：node --check 全触面脚本；3 插件 build-plugin 重建 + lib 语法复验；check-patch-mounts 14 包绿；
  smoke-bridge PASS；check-contract 仅 §1 两项 dsh/ 协调库路径缺失——git stash 对照 HEAD 基线同样失败，
  非本轮回归。YAML parse OK；EngineManager.kt 括号配平机检 OK（字符串/注释/三引号先行剥离）。
- Kotlin 完整编译验证 = 第三轮（PR gate 实跑，本地无 Android SDK 不装样子）。

### 复盘第三轮（编译验证 + 收口）

- **环境实锤（非代码问题）**：PR #1 触发 pr-gate 双 job 均「failure」，annotations 实锤
  = `The job was not started because recent account payments have failed or your spending
  limit needs to be increased`——当日 15:32 同仓库双 workflow 尚全绿（~90min runner 时长），
  21:48 起 job 无法排队：账户级 Actions 计费/支出限额阻断，rerun（attempt 2）秒败同因。
- **替代验证（本地实跑 gradle）**：沙箱装 Android SDK（commandlinetools + platforms;android-36
  + build-tools;36.0.0）后 `./gradlew :app:compileDebugKotlin --no-daemon` → **BUILD SUCCESSFUL
  (2m34s, rc=0)**——与 CI 编译门禁同一 task、同 compileSdk 36 语义，EngineManager.kt 全部新
  代码（staging/promoteTree/verifyRootfs/AssetManifest/stamp）实机编译通过，仅存量 deprecation
  警告（MainActivity/OverlayService，非本轮触面）。
- 结论：三轮复盘收口。代码面：静态 diff 审查修 3 处 → 行为仿真 + 门禁全绿 → 真机同版编译门禁绿。
  CI 面：合入 main 触发 build-apk；若仍被计费阻断，恢复后 re-run workflow 即出包（构建链无代码依赖此阻断）。

## 7. 真机报告反查（追加，坑 47）

三轮复盘的「行为仿真」用的假 rootfs 只有 8 成员、无软链落在 `PROBE_MEMBERS`，恰好漏掉一种不对称：
- **生成端** `memberSha` = `tar -O`，对软链吐 0 字节 → `sha256("")`；
- **壳端** `verifyRootfs` 对软链 = `sha256(readSymbolicLink().toString())`。

设备端报告「`/home/.dsh/ubuntu-rootfs` ≈1.5MB」正击中此路径：真 minbase 里 `etc/os-release` 就是软链
（→ `../usr/lib/os-release`），完整解压也必抛 `probe hash mismatch` → stamp 永不写 → 每次冷启
全量重解 → 反复失败留下的碎片远小于 293M。

修复 = 新增 `probeSha()`，软链成员按链接目标串哈希、常规文件保持 `tar -O`；tarIndex 补 `link` 字段透传。
回归门禁 = `scripts/check-asset-manifest.mjs`（合成含软链 probe 成员的假 rootfs，逐条复刻壳侧
`verifyRootfs` 双向对账，硬断言「软链 probe 哈希 != sha256("")」）。

端到端复验 = 对真实 12683 成员 rootfs 逐行复刻 `verifyRootfs` 算法：
① 修前清单跑完整解压 → `etc/os-release` MISMATCH，exit=1（复现永不收敛）；
② 修后清单跑完整解压 → CONVERGED（12683=12683、bytes 292934755 精确、4/4 probes 全绿）；
③ 修后清单跑半份树 → walk 3351 < 12683 立即 FAIL（下界捕获仍有效）。

伴生澄清：Java `File(parent, "/abs/x")` 会把绝对链接重挂 dest 内，1517 软链 shell-canonical 全通过
（早期"215 unsafe"扫描是误报）。产物：重打包 APK 349M，`sha256 69af991490e0c34b334011a47e1b4f73ead9f587f6d505354aab3a87e7f776e3`，
已直传替换 Release v0.13.2-seagull-light 的旧坏包。
