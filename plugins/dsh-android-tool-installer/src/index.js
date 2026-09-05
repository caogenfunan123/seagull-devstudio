/**
 * @dsh-android/dsh-android-tool-installer - three-tier tool registry & on-demand install.
 * L1 built-in (apktool/jadx, auto) / L2 user opt-in (radare2/rizin).
 * Provides toolInstaller service + tool_install / tool_list model tools.
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { mkdirSync, existsSync, createWriteStream, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

// 运行时前缀由引擎 shellEnv() 注入（TERMUX__PREFIX/PREFIX），回退到本 fork 安装包路径。
// 本 fork applicationId = com.dsharnessmobile.shell（编译安装后即此路径）。
function runtimePrefix() {
  return process.env.TERMUX__PREFIX || process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr';
}
const USR = runtimePrefix();

const TOOL_REGISTRY = {
  apktool: {
    tier: 'L1', type: 'java-jar', install: 'auto',
    source: 'https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar',
    installPath: join(USR, 'share', 'apktool', 'apktool.jar'),
    sha256: '7956eb04194300ce0d0a84ad18771eebc94b89fb8d1ddcce8ea4c056818646f4',
    description: 'APK decompile & rebuild (jar)',
  },
  jadx: {
    tier: 'L1', type: 'archive-zip', install: 'auto',
    source: 'https://github.com/skylot/jadx/releases/download/v1.5.0/jadx-1.5.0.zip',
    installPath: join(USR, 'share', 'jadx'),
    sha256: 'c5a713fa4800cbb9e6df85ced1bef95ba329040c95cb87d54465f108483e4ef9',
    description: 'DEX to Java decompiler (zip)',
  },
  radare2: {
    tier: 'L2', type: 'native', install: 'user-opt-in',
    // 官方 Android aarch64 预编译（此前错用源码 tar.xz，装了只是份源码跑不起来）。
    // tar 顶层带 data/data/org.radare.radare2installer/radare2/ 前缀（4 层），解压需剥离。
    source: 'https://github.com/radareorg/radare2/releases/download/5.9.8/radare2-5.9.8-android-aarch64.tar.gz',
    installPath: join(USR, 'share', 'radare2'),
    stripComponents: 4,
    sha256: '28b07bbcf345fbb4a59a90e9a8c4dade6196a810c33f88516f11c4ae4cb12a47',
    description: 'Reverse engineering framework (CLI)',
  },
  rizin: {
    tier: 'L2', type: 'native', install: 'user-opt-in',
    // 官方资产名 rizin-v0.7.4-android-aarch64.tar.gz（arm64 原生安卓版）。
    // tar 顶层带 data/data/org.rizinorg.rizininstaller/ 前缀（3 层），解压需剥离。
    source: 'https://github.com/rizinorg/rizin/releases/download/v0.7.4/rizin-v0.7.4-android-aarch64.tar.gz',
    installPath: join(USR, 'share', 'rizin'),
    stripComponents: 3,
    sha256: 'ff9919dfbaf23d84e7199b7a5f9f6f0a7643a5fcf0741998d503859d4b0e69a1',
    description: 'Modern reverse engineering framework',
  },
};

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Seagull-DevStudio/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error('HTTP ' + res.statusCode + ' on ' + url));
      }
      const total = Number(res.headers['content-length']) || null;
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => { file.close(); reject(err); });
  });
}

/** 计算文件 sha256（流式，大文件不爆内存）。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(file);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

/** 依据 source 扩展名判定安装物形态：file(jar) / zip / targz / tarxz。 */
function archiveKind(source) {
  if (/\.tar\.gz$|\.tgz$/.test(source)) return 'targz';
  if (/\.tar\.xz$/.test(source)) return 'tarxz';
  if (/\.zip$/.test(source)) return 'zip';
  return 'file';
}

/**
 * 解压下载的归档到 destDir。tar.* 用 tar（快照/基座必备），zip 用 unzip。
 * @param strip 剥离前缀层数（radare2/rizin 官方 android 资产带 data/data/<installer>/ 前缀）。
 */
async function extractArchive(file, destDir, kind, strip) {
  mkdirSync(destDir, { recursive: true });
  const stripArg = strip > 0 ? `--strip-components=${strip}` : null;
  let cmd; let args;
  if (kind === 'targz') { cmd = 'tar'; args = [stripArg, '-xzf', file, '-C', destDir].filter(Boolean); }
  else if (kind === 'tarxz') { cmd = 'tar'; args = [stripArg, '-xJf', file, '-C', destDir].filter(Boolean); }
  else if (kind === 'zip') { cmd = 'unzip'; args = ['-q', '-o', file, '-d', destDir]; }
  else return { ok: false, error: '不支持的归档类型: ' + kind };
  try {
    await execFileAsync(cmd, args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '解压失败（' + cmd + '）：' + err.message };
  }
}

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

function buildService() {
  const task = { name: null, phase: 'idle', startedAt: null, bytesReceived: 0, totalBytes: null, error: null, finishedAt: null };
  function beginTask(name) {
    task.name = name; task.phase = 'downloading'; task.startedAt = Date.now();
    task.bytesReceived = 0; task.totalBytes = null; task.error = null; task.finishedAt = null;
  }
  function setProgress(received, total) { task.bytesReceived = received; task.totalBytes = total; }
  function setPhase(phase) { task.phase = phase; }
  function finishTask(error) { task.phase = error ? 'failed' : 'done'; task.error = error || null; task.finishedAt = Date.now(); }

  return {
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
    status() {
      const running = task.phase === 'downloading' || task.phase === 'verifying' || task.phase === 'extracting';
      const pct = task.totalBytes ? Math.round((task.bytesReceived / task.totalBytes) * 100) : null;
      return { ...task, running, percent: pct };
    },
    async install(name, opts = {}) {
      const info = TOOL_REGISTRY[name];
      if (!info) return { ok: false, error: 'Unknown tool: ' + name };
      if (existsSync(info.installPath) && !opts.force) return { ok: true, alreadyInstalled: true };
      if (opts.force && existsSync(info.installPath)) {
        const { rmSync } = await import('node:fs');
        try { rmSync(info.installPath, { recursive: true, force: true }); } catch {}
      }
      const dl = info.installPath + '.download';
      beginTask(name);
      try {
        await downloadFile(info.source, dl, (received, total) => setProgress(received, total));
        if (info.sha256 && !info.sha256.startsWith('__')) {
          setPhase('verifying');
          const got = await sha256File(dl);
          if (got !== info.sha256) {
            const { unlinkSync } = await import('node:fs');
            try { unlinkSync(dl); } catch {}
            finishTask('sha256 校验失败：期望 ' + info.sha256 + '，实际 ' + got);
            return { ok: false, error: 'sha256 校验失败：期望 ' + info.sha256 + '，实际 ' + got };
          }
        }
        const kind = archiveKind(info.source);
        if (kind === 'file') {
          // jar 等直接文件：.download 与 installPath 同目录，宿主侧 rename 原子完成。
          // 切勿经 proot 容器 mv——proot-entry 只 bind /dev /proc /sys /storage 与 $HOME，
          // 未 bind 宿主 files/usr，容器内看不到下载文件（源缺失，安装必失败）。
          const { renameSync } = await import('node:fs');
          renameSync(dl, info.installPath);
        } else {
          setPhase('extracting');
          const r = await extractArchive(dl, info.installPath, kind, info.stripComponents || 0);
          if (!r.ok) { finishTask(r.error); return r; }
          const { unlinkSync } = await import('node:fs');
          try { unlinkSync(dl); } catch {}
        }
        finishTask();
        return { ok: true, installed: true, path: info.installPath };
      } catch (err) {
        finishTask(err.message);
        return { ok: false, error: err.message };
      }
    },
  };
}

function tools(service) {
  const installTool = defineTool({
    name: 'tool_install',
    description: 'Install a development tool from the three-tier registry (apktool, jadx, radare2, rizin).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to install.' },
        force: { type: 'boolean', description: 'Reinstall over the existing tool (delete then re-download).' },
      },
      required: ['name'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ name, force = false }) { return service.install(name, { force }); },
  });

  const upgradeTool = defineTool({
    name: 'tool_upgrade',
    description:
      'Upgrade an installed tool to the registry target version by force-reinstalling it ' +
      '(delete existing install, re-download, re-verify sha256, re-extract).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tool name to upgrade.' } },
      required: ['name'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ name }) { return service.install(name, { force: true }); },
  });

  const listTool = defineTool({
    name: 'tool_list',
    description: 'List all available tools with install status.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, tools: service.list() }; },
  });

  const statusTool = defineTool({
    name: 'tool_status',
    description:
      'Report the current or last tool install task progress (phase, bytes, percent, error). ' +
      'Poll this to track a long tool_install download/extract instead of blocking.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...service.status() }; },
  });

  return [installTool, upgradeTool, listTool, statusTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  const service = buildService();
  ctx.provide('toolInstaller', service);
  for (const t of tools(service))
    ctx.tools.register(t);
}
