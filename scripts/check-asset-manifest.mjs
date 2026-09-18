// check-asset-manifest.mjs — 资产清单防坏门禁（回归坑 44/45/47）
//
// 用「合成一个含软链成员的假 rootfs → 跑真实 gen-asset-manifest → 逐条复刻壳侧
// EngineManager.verifyRootfs 口径做双向往返」，锁死三次历史翻车的两侧不一致：
//   坑 44 半份定格 → 本门禁断言「解一半」必被下界捕获；
//   坑 45 计数口径 → 本门禁按规范化落点去重（生成端）与 walkTopDown（壳端）对账；
//   坑 47 软链哈希 → fixture 强制含软链 probe 成员（etc/os-release、bin/bash），
//        断言生成端哈希 == 壳端「按链接目标串」哈希，且 != sha256("")（禁止 tar -O 对软链吐空串）。
//
// 用法：node scripts/check-asset-manifest.mjs   （全离线；无需网络/真机；CI 与本地均可跑）
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync,
  readdirSync, symlinkSync, readlinkSync,
} from 'node:fs'
import { join, dirname, relative, sep, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GEN = join(ROOT, 'scripts', 'gen-asset-manifest.mjs')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const EMPTY_SHA = sha256(Buffer.alloc(0))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: opts.encoding || 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').toString().slice(0, 400)}`)
  return r.stdout
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
// 归一化 POSIX 风格相对路径，跨平台把本地 sep 折成 '/'，便于 startsWith 比较。
const asPosix = (p) => p.split(sep).join('/')

const work = join(tmpdir(), `asset-check-${Date.now()}`)
const top = 'fake-rootfs-top'
const base = join(work, top)
const assets = join(work, 'assets')
mkdirSync(assets, { recursive: true })

const rel = (p) => join(base, p)
function putFile(p, content) { const f = rel(p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content) }
function putLink(p, target) {
  const f = rel(p); mkdirSync(dirname(f), { recursive: true })
  if (existsSync(f) || isLink(f)) rmSync(f, { force: true })
  symlinkSync(target, f)
}

// ---- 1) 合成假 rootfs：常规文件 + 命中 PROBE_MEMBERS 的软链（坑 47 靶心）----
putFile('usr/bin/bash', '#!/bin/bash fake\n')
putFile('usr/bin/apt', '#!/usr/bin/apt fake\n')
putFile('usr/lib/os-release', 'ID=fakeubuntu\n')
putFile('etc/resolv.conf', 'nameserver 8.8.8.8\n')
putLink('etc/os-release', '../usr/lib/os-release') // 命中 PROBE_MEMBERS，且为软链
putLink('bin/bash', '../usr/bin/bash')             // 命中 PROBE_MEMBERS（bin/bash），且为软链

sh('tar', ['-cJf', join(assets, 'ubuntu-rootfs.tar.xz'), '-C', work, top])

// ---- 2) 跑真实生成器 ----
sh('node', [GEN, assets])
const manifest = JSON.parse(readFileSync(join(assets, 'asset-manifest.json'), 'utf8'))
const rs = manifest.rootfsStats['ubuntu-rootfs.tar.xz']

// ---- 3) 复刻壳侧 extractTarAsset 落地（软链保留目标串；绝对/相对链接按 Java File(parent,link) 语义解析、只拒绝逃逸 dest 者）----
const st = join(work, 'staging')
const index = JSON.parse(sh('python3', ['-c',
  'import tarfile,json,sys\n' +
  't=tarfile.open(sys.argv[1])\n' +
  'out=[{"name":m.name,"link":(m.linkname if m.issym() else ""),' +
  '"type":("d" if m.isdir() else ("l" if m.issym() else ("h" if m.islnk() else "f")))} for m in t]\n' +
  'print(json.dumps(out))',
  join(assets, 'ubuntu-rootfs.tar.xz')]))
const topPrefix = index.map((m) => m.name.replace(/^\.\//, '').replace(/^\/+/, '').split('/')[0]).find((x) => x)
function normName(n) {
  let x = n.replace(/^\.\//, '').replace(/^\/+/, '')
  if (topPrefix && x === topPrefix) return ''
  if (topPrefix && x.startsWith(topPrefix + '/')) x = x.slice(topPrefix.length + 1)
  return x
}
for (const m of index) {
  const p = normName(m.name)
  if (!p || p.includes('..')) continue
  const full = join(st, p)
  if (m.type === 'd') { mkdirSync(full, { recursive: true }); continue }
  mkdirSync(dirname(full), { recursive: true })
  if (m.type === 'l') {
    // 对齐壳侧：linkTarget = File(File(dest,name).parentFile, entry.linkName)。Java File(child,"/abs/x") 会把
    // "/abs" 前导 / 吃掉变成 parent 相对。所以 strip 前导 / 后 join dirname(p) + link，再 normalize。
    // canonical 判定：linkCanon.startsWith(destCanon + sep) 才算安全（strictly 在 dest 内）。
    const link = m.link.replace(/^\/+/, '')
    const resolved = normalize(join(st, dirname(p), link))
    const safe = resolved !== st && (asPosix(relative(st, resolved)) !== '' && !asPosix(relative(st, resolved)).startsWith('..' + sep) && asPosix(relative(st, resolved)) !== '..')
    if (safe) {
      if (existsSync(full) || isLink(full)) rmSync(full, { force: true })
      symlinkSync(m.link, full)
    }
    continue
  }
  if (m.type === 'h') { writeFileSync(full, Buffer.alloc(0)); continue }
  const raw = sh('tar', ['-xf', join(assets, 'ubuntu-rootfs.tar.xz'), m.name, '-O'], { encoding: 'buffer' })
  writeFileSync(full, raw)
}

// ---- 4) 复刻壳侧 verifyRootfs：walk 下界 + 字节下界 + probe（软链按目标串、文件按内容）----
function walk(root) {
  let files = 0, bytes = 0
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      files++
      let ls; try { ls = lstatSync(p) } catch { continue }
      if (ls.isSymbolicLink()) continue
      if (ls.isDirectory()) { stack.push(p); continue }
      if (ls.isFile()) bytes += ls.size
    }
  }
  return { files, bytes }
}
const probeHash = (p) => isLink(p) ? sha256(Buffer.from(readlinkSync(p), 'utf8')) : sha256(readFileSync(p))

let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : '  FAIL'} ${msg}`); if (!cond) failures++ }

const { files, bytes } = walk(st)
ok(files >= rs.members, `members 下界: walk ${files} >= manifest ${rs.members}（坑 45 同口径）`)
ok(bytes >= rs.fileBytes, `bytes 下界: walk ${bytes} >= manifest ${rs.fileBytes}`)

let symProbeSeen = 0
for (const [p, exp] of Object.entries(manifest.probes)) {
  const got = probeHash(join(st, p))
  ok(got === exp, `probe 两侧一致: ${p} got=${got.slice(0, 12)} exp=${exp.slice(0, 12)}`)
  if (isLink(join(st, p))) {
    symProbeSeen++
    ok(exp !== EMPTY_SHA, `软链 probe 非空串哈希（坑 47 锁）: ${p}`)
  }
}
ok(symProbeSeen > 0, 'fixture 至少含一个软链 probe 成员（否则坑 47 回归锁失效）')

// ---- 5) 负例：半份必被下界捕获（坑 44 回归）----
const leaves = []
;(function collect(d) {
  for (const n of readdirSync(d)) { const p = join(d, n); if (isLink(p)) { leaves.push(p); continue } let ls; try { ls = lstatSync(p) } catch { continue } if (ls.isDirectory()) collect(p); else leaves.push(p) }
})(st)
for (const p of leaves.slice(0, Math.ceil(leaves.length / 2))) rmSync(p, { force: true })
const hw = walk(st)
ok(hw.files < rs.members || hw.bytes < rs.fileBytes, `半份被捕获（坑 44）: walk ${hw.files}/${hw.bytes} 不达 members=${rs.members}/bytes=${rs.fileBytes}`)

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '[check-asset-manifest] 全绿 ✅' : `[check-asset-manifest] ${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
