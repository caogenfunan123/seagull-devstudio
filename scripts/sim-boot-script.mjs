// sim-boot.mjs — 沙箱模拟 scripts/seagull-ubuntu-boot.sh 的挂载决策逻辑（不碰真 mount）。
// 手法：把脚本里的 /proc/mounts 换成假文件，mount/umount 换成记账 stub，验证：
//   ① 遗留 host-home bind 被摘除（fake mounts 中消失）；
//   ② 窄 bind 挂上（fetched→C_FETCHED、workspaces→C_WORKSPACE 各一条）；
//   ③ 幂等：跑第二遍不多挂、不误摘；
//   ④ 关键红线：mounts 里绝无任何一条的 src 是 files/home 或 .dsh（整块 home/祖先 bind 禁止复发）。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const W = '/tmp/boot-sim'
rmSync(W, { recursive: true, force: true })
const DATA = join(W, 'data/data/com.dsharnessmobile.shell/files')
const HOME = join(DATA, 'home')
const ROOTFS = join(HOME, '.dsh/ubuntu-rootfs')
mkdirSync(join(HOME, '.dsh/fetched'), { recursive: true })
mkdirSync(join(HOME, '.dsh/workspaces'), { recursive: true })
mkdirSync(join(ROOTFS, 'etc'), { recursive: true })

const M = join(W, 'fake-mounts')
// 初始状态：模拟真机——遗留 host-home over-broad bind + 正常 proc
writeFileSync(M, [
  `/dev/block/dm-51 ${join(HOME, '.dsh/ubuntu-rootfs/host-home')} f2fs rw 0 0`,
  `/dev/block/dm-51 ${join(HOME, '.dsh/ubuntu-rootfs')} f2fs rw 0 0`,
  'proc /some/other proc rw 0 0',
].join('\n') + '\n')

let src = readFileSync(join(ROOT, 'scripts', 'seagull-ubuntu-boot.sh'), 'utf8')
// 路径重定向 + mount/umount 桩：直接文本改写为对假 mounts 文件的记账操作
src = src
  .replaceAll('/data/data/$PKG/files', DATA)
  .replaceAll('/proc/mounts', M)
  .replace('#!/system/bin/sh', '#!/bin/sh')
  .replaceAll('mount --bind "$src" "$dst" 2>/dev/null', `printf '%s %s f2fs rw 0 0\\n' "$src" "$dst" >> ${M}`)
  .replaceAll('umount -l "$dst" 2>/dev/null', `FOK_TMP=\$(grep -v " $dst " ${M} || true); printf '%s\\n' "\$FOK_TMP" > ${M}`)
  .replaceAll('umount -l "$LEGACY" 2>/dev/null', `FOK_TMP=\$(grep -v "$LEGACY" ${M} || true); printf '%s\\n' "\$FOK_TMP" > ${M}`)
  .replaceAll('mount -t proc proc "$ROOTFS/proc" 2>/dev/null', '')
  .replaceAll('mount --bind /dev "$ROOTFS/dev" 2>/dev/null', '')
  .replaceAll('mount -t devpts devpts "$ROOTFS/dev/pts" 2>/dev/null', '')
  .replaceAll('mount -t binfmt_misc none /proc/sys/fs/binfmt_misc 2>/dev/null', '')
writeFileSync(join(W, 'boot-stub.sh'), src)

function run() { execSync(`/bin/sh ${join(W, 'boot-stub.sh')}`, { stdio: 'inherit' }) }
function mounts() { return readFileSync(M, 'utf8').trim().split('\n') }

run(); const first = mounts(); run(); const second = mounts()

let fail = 0
const ok = (c, m) => { console.log(`${c ? '  ok ' : '  FAIL'} ${m}`); if (!c) fail++ }
const srcOf = (line) => line.split(' ')[0]
const dstOf = (line) => line.split(' ')[1]

ok(!first.some((l) => dstOf(l) === join(ROOTFS, 'host-home')), '① 遗留 host-home bind 已摘除')
ok(first.some((l) => srcOf(l) === join(HOME, '.dsh/fetched') && dstOf(l) === join(ROOTFS, 'host-shared/fetched')), '② fetched 窄 bind 挂上')
ok(first.some((l) => srcOf(l) === join(HOME, '.dsh/workspaces') && dstOf(l) === join(ROOTFS, 'host-shared/workspace')), '② workspaces 窄 bind 挂上')
ok(first.filter((l) => l.includes('host-shared')).length === 2, '③ 幂等：无重复窄 bind')
ok(JSON.stringify(first.sort()) === JSON.stringify(second.sort()), '③ 幂等：第二遍 mounts 不变')
ok(!first.some((l) => srcOf(l) === HOME || srcOf(l) === join(HOME, '.dsh')), '④ 红线：home/.dsh 整块 bind 零出现')
console.log(fail === 0 ? '[sim-boot] 全绿 ✅' : `[sim-boot] ${fail} 失败 ❌`)
rmSync(W, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
