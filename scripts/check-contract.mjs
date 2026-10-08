// check-contract.mjs — adapter-layer contract point check (core M1.4 adapter chain check).
// Consumes scripts/contract.json; any broken point → non-zero exit + report. Usage: node scripts/check-contract.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const contract = JSON.parse(readFileSync(join(root, 'scripts/contract.json'), 'utf8'))
const issues = []
const ok = (msg) => console.log('  OK  ' + msg)
const fail = (msg) => { issues.push(msg); console.log('  FAIL ' + msg) }

function dtsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...dtsFiles(p))
    else if (p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

console.log('== 1. bundle 行引用 ==')
// 自包含 CI 无协调库（dsh/）在场：缺场 SKIP（warn），在场严格校验（2026-10 第三轮复盘
// 接线 pr-gate 时发现——原实现在自包含仓库恒 FAIL 9 项，门禁要么恒红要么被绕过）。
const upstreamInPlace = existsSync(join(root, contract.upstreamRepo))
for (const row of contract.rows) {
  const patchFile = join(root, contract.upstreamRepo, 'packages/bundle', row.bundle, 'cordis.patch.yml')
  if (!upstreamInPlace) { console.log('  SKIP 行 ' + row.id + '（协调库 ' + contract.upstreamRepo + ' 不在场）'); continue }
  if (!existsSync(patchFile)) { fail('bundle patch 缺失: ' + patchFile); continue }
  const text = readFileSync(patchFile, 'utf8')
  const hit = text.split('\n').find(l => l.trim() === '- id: ' + row.id)
  if (hit === undefined) fail('行 ' + row.id + ' 在上游 ' + row.bundle + ' bundle 中不存在（patch 静默失效风险）')
  else ok('行 ' + row.id + ' @ ' + row.bundle + ' 存在')
}

console.log('== 2. 插入行包存在（仓库 + 构建产物） ==')
for (const ins of contract.inserted) {
  const repo = join(root, ins.repo)
  if (!existsSync(join(repo, 'package.json'))) fail('仓库缺失: ' + ins.repo)
  else ok('仓库 ' + ins.repo + ' 存在')
  const built = existsSync(join(repo, 'lib/index.js')) || existsSync(join(repo, 'lib/client.js'))
  // lib/ 未构建在 CI 静态门禁里仅 warn：构建产物由 build-apk 的 requires 段强制（缺即拒打包），
  // 此处只守仓库存在性，避免 pr-gate 恒红（2026-10 第三轮复盘接线调整）。
  if (!built) console.log('  WARN ' + ins.repo + ' lib/ 未构建（build-apk 门禁负责强制构建）')
  else ok(ins.repo + ' lib/ 已构建')
}

console.log('== 3. 继承符号（基线 node_modules 类型面） ==')
const baseline = join(root, contract.symbols[0].repo, 'node_modules/@deepseek-ai')
// 基线 node_modules 不在场（未 npm install / 自包含 CI 不装插件依赖）→ 整节 SKIP；
// 在场则逐符号严格校验（2026-10 第三轮复盘接线调整）。
if (!existsSync(baseline)) {
  console.log('  SKIP 基线 node_modules 不在场（' + contract.symbols[0].repo + ' 未 npm install）')
} else {
  for (const sym of contract.symbols) {
    const typesDir = join(baseline, sym.pkg, 'lib/types')
    if (!existsSync(typesDir)) { fail('基线缺失 ' + sym.pkg + '/lib/types（先 npm install）'); continue }
    const found = dtsFiles(typesDir).some(f => readFileSync(f, 'utf8').includes(sym.symbol))
    if (found) ok(sym.pkg + ': ' + sym.symbol)
    else fail(sym.pkg + ': 符号 ' + sym.symbol + ' 不在基线类型面（继承面断裂）')
  }
}

console.log('== 4. 客户端槽位声明 ==')
const slotText = readFileSync(join(root, contract.clientSlots.repo, 'src/client/index.ts'), 'utf8')
for (const slot of contract.clientSlots.slots) {
  if (slotText.includes("'" + slot + "'")) ok('槽位 ' + slot + ' 已声明')
  else fail('槽位 ' + slot + ' 未声明')
}

console.log('== 5. 环境契约键 ==')
const envText = readFileSync(join(root, contract.envContract.repo, 'src/index.ts'), 'utf8')
for (const key of contract.envContract.keys) {
  if (envText.includes(key)) ok('环境键 ' + key + ' 注入')
  else fail('环境键 ' + key + ' 未注入')
}

console.log('== 6. 版本钉（package.json vs contract.json） ==')
// Upstream does not republish every package on each engine train (e.g.
// dsh-client-runtime has no 0.1.5 line); baselineExceptions pins those
// per-package so the gate stays meaningful instead of permanently red.
const exceptions = contract.baselineExceptions ?? {}
for (const repo of contract.inserted.map(i => i.repo)) {
  const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
  for (const [dep, pin] of Object.entries(pkg.devDependencies ?? {})) {
    if (!dep.startsWith('@deepseek-ai/dsh-')) continue
    const want = exceptions[dep] ?? contract.baseline
    if (pin !== want) {
      fail(repo + ': ' + dep + ' 钉 ' + pin + ' ≠ 基线 ' + want)
    }
  }
  const cordisPin = pkg.devDependencies?.['@deepseek-ai/cordis'] ?? pkg.peerDependencies?.['@deepseek-ai/cordis']
  if (cordisPin !== contract.cordis) fail(repo + ': cordis 钉 ' + cordisPin + ' ≠ ' + contract.cordis)
}
ok('版本钉检查完成')

if (issues.length > 0) {
  console.error('')
  console.error('CONTRACT FAIL (' + issues.length + '):')
  for (const i of issues) console.error('  - ' + i)
  process.exit(1)
}
console.log('')
console.log('CONTRACT PASS')
