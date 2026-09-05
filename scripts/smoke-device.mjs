#!/usr/bin/env node
/**
 * smoke-device.mjs — Seagull DevStudio 真机冒烟（手动 / 自托管 runner 用，CI 无设备不跑）。
 *
 * 校验链路（每步 PASS/FAIL，全过退出码 0）：
 *   1. adb 可用 + 设备连接（device 状态）
 *   2. （可选）安装 APK
 *   3. 引擎探活（adb forward → HTTP 127.0.0.1:<probe> → 引擎 32080）
 *   4. root 通道（su -c id 回 uid=0）
 *   5. 工具装配（apktool/jadx/apksigner 落点）
 *   6. Ubuntu 容器（proot-entry.sh 落点）
 *
 * 用法：
 *   node scripts/smoke-device.mjs [--serial <id>] [--apk <path.apk>] [--skip-install]
 *                                [--engine-port 32080] [--probe-port 23080]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const execFileAsync = promisify(execFile);

const PKG = 'com.dsharnessmobile.shell';
const FILES = `/data/data/${PKG}/files`;

function parseArgs(argv) {
  const o = { serial: null, apk: null, skipInstall: false, enginePort: 32080, probePort: 23080 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serial') o.serial = argv[++i];
    else if (a === '--apk') o.apk = argv[++i];
    else if (a === '--skip-install') o.skipInstall = true;
    else if (a === '--engine-port') o.enginePort = Number(argv[++i]);
    else if (a === '--probe-port') o.probePort = Number(argv[++i]);
  }
  return o;
}

async function run(cmd, args, timeout = 60000) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
  }
}

function adbArgs(o, args) {
  return o.serial ? ['-s', o.serial, ...args] : args;
}

/** 设备侧 su -c（命令单引号包裹，规避 adb shell 引号地狱，坑 8）。 */
function suArgs(o, cmd) {
  return adbArgs(o, ['shell', `su -c '${cmd.replace(/'/g, `'\\''`)}'`]);
}

function httpProbe(port, path = '/', timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

async function main() {
  const o = parseArgs(process.argv);
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail: detail || undefined });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  };

  const adbCheck = await run('adb', ['version']);
  if (!adbCheck.ok) {
    console.error('adb 不可用：' + adbCheck.error);
    process.exit(1);
  }
  record('adb', true);

  const dev = await run('adb', ['devices']);
  const connected = (dev.stdout || '').split('\n').slice(1)
    .filter((l) => /\tdevice$/.test(l.trim()))
    .map((l) => l.trim().split('\t')[0]);
  if (connected.length === 0) {
    record('device', false, '无 device 状态设备（adb devices 无 device 行）');
  } else if (!o.serial && connected.length > 1) {
    record('device', false, `多设备（${connected.join(', ')}），请用 --serial 指定`);
  } else {
    if (!o.serial) o.serial = connected[0];
    record('device', true, o.serial);
  }

  if (o.apk && !o.skipInstall) {
    const inst = await run('adb', adbArgs(o, ['install', '-r', '-t', o.apk]), 300000);
    record('install', inst.ok, inst.ok ? '' : (inst.error || inst.stderr));
  }

  await run('adb', adbArgs(o, ['forward', `tcp:${o.probePort}`, `tcp:${o.enginePort}`]));
  let engineOk = false;
  let engineStatus = 'timeout';
  for (let i = 0; i < 24; i++) {
    const p = await httpProbe(o.probePort, '/', 5000);
    if (p.ok) { engineOk = true; engineStatus = String(p.status); break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  record('engine', engineOk, engineOk ? 'HTTP ' + engineStatus : '120s 内未探活');

  const root = await run('adb', suArgs(o, 'id'), 30000);
  record('root', root.ok && /uid=0\(root\)/.test(root.stdout || ''), root.stdout || root.error || root.stderr);

  const toolLs = `ls ${FILES}/usr/share/apktool/apktool.jar ${FILES}/usr/share/jadx/lib/jadx-1.5.0-all.jar ${FILES}/usr/share/apksigner/apksigner.jar 2>&1`;
  const tools = await run('adb', suArgs(o, toolLs), 30000);
  const toolOk = tools.ok && /apktool\.jar/.test(tools.stdout || '') && /jadx-1\.5\.0-all\.jar/.test(tools.stdout || '') && /apksigner\.jar/.test(tools.stdout || '');
  record('tools', toolOk, toolOk ? 'apktool/jadx/apksigner 就绪' : (tools.stdout || tools.error || tools.stderr));

  const cont = await run('adb', suArgs(o, `ls ${FILES}/home/.dsh/ubuntu-rootfs/proot-entry.sh 2>&1`), 30000);
  record('ubuntu', cont.ok && /proot-entry\.sh/.test(cont.stdout || ''), cont.stdout || cont.error || cont.stderr);

  console.log('\n' + JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
