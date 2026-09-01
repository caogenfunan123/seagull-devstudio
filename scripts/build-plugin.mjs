#!/usr/bin/env node
/**
 * build-plugin.mjs — 把纯 JS 插件的 src/index.js 构建为 lib/index.js
 *
 * DSH 快照的插件注入链（inject-snapshot.py）只注入 lib/ 与 package.json，
 * main 必须指向 lib/index.js。本脚本为无 TS 依赖的纯 JS 插件做等价构建：
 *   node scripts/build-plugin.mjs <plugin-short-name>
 *   （插件位于 plugins/dsh-android-<name>/，产物 plugins/dsh-android-<name>/lib/）
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const name = process.argv[2]
if (!name) {
  console.error('用法: node scripts/build-plugin.mjs <plugin-short-name>')
  process.exit(2)
}

const pkgDir = join(ROOT, 'plugins', `dsh-android-${name}`)
const src = join(pkgDir, 'src', 'index.js')
const lib = join(pkgDir, 'lib')

try {
  rmSync(lib, { recursive: true, force: true })
  mkdirSync(lib, { recursive: true })
  copyFileSync(src, join(lib, 'index.js'))
  console.log(`[build-plugin] ${name}: src/index.js -> lib/index.js OK`)
} catch (e) {
  console.error(`[build-plugin] ${name} 构建失败: ${e.message}`)
  process.exit(1)
}
