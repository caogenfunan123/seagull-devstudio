/**
 * @dsh-android/dsh-android-tool-installer - three-tier tool registry & on-demand install.
 * L1 built-in (apktool/jadx, auto) / L2 user opt-in (radare2/rizin).
 * Provides toolInstaller service + tool_install / tool_list model tools.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import https from 'node:https';

const execFileAsync = promisify(execFile);

// 运行时前缀由引擎 shellEnv() 注入（TERMUX__PREFIX/PREFIX），回退到本 fork 安装包路径。
// 本 fork applicationId = com.dsharnessmobile.shell（编译安装后即此路径）。
function runtimePrefix() {
  return process.env.TERMUX__PREFIX || process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr';
}
function runtimeHome() {
  return process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
}
const USR = runtimePrefix();

const TOOL_REGISTRY = {
  apktool: {
    tier: 'L1', type: 'java-jar', install: 'auto',
    source: 'https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar',
    installPath: join(USR, 'share', 'apktool', 'apktool.jar'),
    description: 'APK decompile & rebuild (jar)',
  },
  jadx: {
    tier: 'L1', type: 'archive-zip', install: 'auto',
    source: 'https://github.com/skylot/jadx/releases/download/v1.5.0/jadx-1.5.0.zip',
    installPath: join(USR, 'share', 'jadx'),
    description: 'DEX to Java decompiler (zip)',
  },
  radare2: {
    tier: 'L2', type: 'native', install: 'user-opt-in',
    source: 'https://github.com/radareorg/radare2/releases/download/5.9.8/radare2-5.9.8.tar.xz',
    installPath: join(USR, 'share', 'radare2'),
    description: 'Reverse engineering framework (CLI)',
  },
  rizin: {
    tier: 'L2', type: 'native', install: 'user-opt-in',
    // 官方资产名为 rizin-v0.7.4-android-aarch64.tar.gz（arm64 原生安卓版）
    source: 'https://github.com/rizinorg/rizin/releases/download/v0.7.4/rizin-v0.7.4-android-aarch64.tar.gz',
    installPath: join(USR, 'share', 'rizin'),
    description: 'Modern reverse engineering framework',
  },
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Seagull-DevStudio/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error('HTTP ' + res.statusCode + ' on ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => { file.close(); reject(err); });
  });
}

function prootEntry() {
  return runtimeHome() + '/.dsh/ubuntu-rootfs/proot-entry.sh';
}

export function apply(ctx) {
  const service = {
    list() {
      return Object.entries(TOOL_REGISTRY).map(([name, info]) => ({
        name, tier: info.tier, type: info.type, install: info.install,
        description: info.description, installed: existsSync(info.installPath),
      }));
    },
    info(name) {
      const info = TOOL_REGISTRY[name];
      if (!info) return null;
      return { name, tier: info.tier, description: info.description, installed: existsSync(info.installPath) };
    },
    async install(name) {
      const info = TOOL_REGISTRY[name];
      if (!info) return { ok: false, error: 'Unknown tool: ' + name };
      if (existsSync(info.installPath)) return { ok: true, alreadyInstalled: true };
      try {
        await downloadFile(info.source, info.installPath + '.download');
        // move into place via plain fs (no proot dependency for bare files)
        const entry = prootEntry();
        if (existsSync(entry)) {
          await execFileAsync('/bin/bash', [entry, '-lc',
            'mv ' + info.installPath + '.download ' + info.installPath], { timeout: 300000 });
        } else {
          const { renameSync } = await import('node:fs');
          renameSync(info.installPath + '.download', info.installPath);
        }
        return { ok: true, installed: true, path: info.installPath };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };

  ctx.provide('toolInstaller', service);

  const tools = ctx.get('tools');
  if (tools === undefined) return;
  const disp = [];
  disp.push(tools.register({
    name: 'tool_install',
    description: 'Install a development tool from the three-tier registry (apktool, jadx, radare2, rizin).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tool name to install.' } },
      required: ['name'],
    },
    async execute({ name }) { return service.install(name); },
  }));
  disp.push(tools.register({
    name: 'tool_list',
    description: 'List all available tools with install status.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() { return { ok: true, tools: service.list() }; },
  }));
  ctx.effect(() => () => disp.forEach((d) => d && d()));
}
