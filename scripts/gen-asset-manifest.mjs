// gen-asset-manifest.mjs — 生成 app/src/main/assets/asset-manifest.json（工具资产防坏校验清单）
//
// 背景（2026-09-18 轻资产化改造 P1，对齐 DSHA 的「构建期锁哈希 + 落地后核验」范式）：
// 壳侧 extractToolAssets 旧实现以「5 个文件 exists()」判完成——解压中断/半份落地后
// 永久定格为「成功」，工具装好即坏。本脚本在 gradle 打包前生成清单：
//   assets      — 随包资产本体 sha256（壳侧对逐字节 copy 的 jar/so 落地文件直验）；
//   probes      — rootfs 关键成员 sha256（从归档流式抽出计算，键 = 剥离顶层目录后的落点相对路径）；
//   rootfsStats — rootfs 成员数与解包总字节（壳侧 walk 对账，防「解一半」）。
// 缺失资产自动跳过（轻资产版 jadx/r2/rizin 不再随包）。本地/CI 均可跑，无网络依赖。
//
// 用法：node scripts/gen-asset-manifest.mjs [assetsDir]
//   assetsDir 缺省 = 本仓库 app/src/main/assets；build-apk.mjs 会显式传入其 apkDir 对应路径
//   （协调库本地模式下 apkDir 是 ROOT/dsh-mobile-apk 子目录，写错位置 gradle 根本打包不到）。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'app', 'src', 'main', 'assets')

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** tar 归档（透明解压 gz/xz）成员列表与大小：python3 stdlib tarfile 流式读取。 */
function tarIndex(archive) {
  const py = 'import tarfile,json,sys\n' +
    't=tarfile.open(sys.argv[1])\n' +
    'out=[{"name":m.name,"size":(0 if m.isdir() else m.size),"link":(m.linkname if m.issym() else ""),"type":("d" if m.isdir() else ("l" if m.issym() else "f"))} for m in t]\n' +
    'print(json.dumps(out))\n'
  const r = spawnSync('python3', ['-c', py, archive], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('tarIndex 失败: ' + (r.stderr || '').slice(0, 400))
  return JSON.parse(r.stdout)
}

/** 剥离 ./ 与顶层目录后的落点名；返回 (index, topPrefix)。 */
function normalizeIndex(index) {
  let top = null
  for (const m of index) {
    const first = m.name.replace(/^\.\//, '').replace(/^\/+/, '').split('/')[0]
    if (first) { top = first; break }
  }
  const norm = index.map((m) => {
    let n = m.name.replace(/^\.\//, '').replace(/^\/+/, '')
    if (top && (n === top || n.startsWith(top + '/'))) n = n === top ? '' : n.slice(top.length + 1)
    return { ...m, path: n }
  })
  return { norm, hasTop: !!top }
}

/** 从归档流式抽取指定成员（按原始名）计算 sha256；仅用于常规文件。 */
function memberSha(archive, rawName) {
  const r = spawnSync('tar', ['-xf', archive, rawName, '-O'], { maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) return null
  return createHash('sha256').update(r.stdout).digest('hex')
}

/** 与壳侧 verifyRootfs 同口径：软链成员哈希 = sha256(链接目标字符串)，绝不用 tar -O（对软链吐 0 字节）。 */
function probeSha(m, archive) {
  if (m.type === 'l') return createHash('sha256').update(Buffer.from(m.link || '', 'utf8')).digest('hex')
  return memberSha(archive, m.name)
}

const manifest = { version: 1, generated: new Date().toISOString(), assets: {}, probes: {}, rootfsStats: {} }

// 1) 资产本体哈希（逐字节 copy 落地的项）。snapshot.tar.xz 已有 sha256 指纹体系，跳过。
for (const a of ['tools/apktool.jar', 'tools/jadx.zip', 'tools/radare2.tar.gz', 'tools/rizin.tar.gz',
  'native/liboperit_proot.so', 'native/liboperit_loader.so']) {
  const p = join(ASSETS, a)
  if (existsSync(p)) manifest.assets[a] = sha256File(p)
}

// 2) rootfs 抽检成员 + 统计。minbase 顶层 bin->usr/bin 软链，成员名带或不带顶层目录，
//    统一按剥离后的落点路径为键；tar 归档里软链成员的「内容」=链接目标字符串，同样哈希。
const PROBE_MEMBERS = ['usr/bin/bash', 'bin/bash', 'usr/bin/apt', 'etc/os-release', 'etc/resolv.conf']
const rootfs = join(ASSETS, 'ubuntu-rootfs.tar.xz')
if (existsSync(rootfs)) {
  const { norm } = normalizeIndex(tarIndex(rootfs))
  const byPath = new Map(norm.filter((m) => m.type === 'f' || m.type === 'l').map((m) => [m.path, m]))
  for (const p of PROBE_MEMBERS) {
    const m = byPath.get(p)
    if (!m) continue
    const s = probeSha(m, rootfs)
    if (s) manifest.probes[p] = s
  }
  // 统计：唯一落点数与文件总字节（软链按 0 计，壳侧 walk 同口径）。
  // 键去重 + 剔除 path=''（顶层目录条目本身剥离后不落地）——壳侧 walkTopDown 按「路径」计数，
  // tar 若含重复/冗余目录条目，按「成员数」对账会系统性虚高（轻资产 +8 附加文件尚能掩盖，
  // 真 rootfs ~17k 成员下任何超额的重复条目都会把完整解压误判为「解一半」永不自愈）。
  // P1-B3（2026-10 专家评审修复）：fileBytes 与 members 同口径——均按唯一路径计。
  // 旧实现 members 用 uniquePaths（去重），fileBytes 用 norm（可能含重复路径）——tar 若有
  // 重复条目，字节数虚高。改为先按路径去重再求和。
  const uniquePaths = new Set(norm.map((m) => m.path).filter((p) => p !== ''))
  const uniqueNorm = norm.filter((m) => m.path !== '' && uniquePaths.has(m.path))
  // 二次去重：Set.has 只判存在，不保证每个 path 只出现一次——用 Map 按 path 保留首个
  const seen = new Map()
  for (const m of uniqueNorm) if (!seen.has(m.path)) seen.set(m.path, m)
  const deduped = Array.from(seen.values())
  manifest.rootfsStats['ubuntu-rootfs.tar.xz'] = {
    members: uniquePaths.size,
    fileBytes: deduped.reduce((a, m) => a + (m.type === 'f' ? m.size : 0), 0),
  }
  console.log(`[asset-manifest] rootfs probes=${Object.keys(manifest.probes).length} ` +
    `members=${manifest.rootfsStats['ubuntu-rootfs.tar.xz'].members}`)
}

const out = join(ASSETS, 'asset-manifest.json')
mkdirSync(ASSETS, { recursive: true })
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[asset-manifest] assets=${Object.keys(manifest.assets).length} -> ${out}`)
if (Object.keys(manifest.assets).length === 0) {
  console.warn('[asset-manifest] 警告：无任何资产在场（本地裸构建无大资产属正常；CI 上为异常）')
}
