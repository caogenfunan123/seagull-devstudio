/**
 * @dsh-android/dsh-android-tool-installer - three-tier tool registry & on-demand install.
 * 轻资产语义（2026-09-18 P2）：apktool 随包（tier L1 / install built-in）；
 * jadx/radare2/rizin 不再入 APK，在线安装为主（install online，sha256 内置校验 + 镜像链）。
 * Provides toolInstaller service + tool_install / tool_list model tools.
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { mkdirSync, existsSync, createWriteStream, createReadStream, writeFileSync } from 'node:fs';
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
    tier: 'L1', type: 'java-jar', install: 'built-in',
    source: 'https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar',
    installPath: join(USR, 'share', 'apktool', 'apktool.jar'),
    sha256: '7956eb04194300ce0d0a84ad18771eebc94b89fb8d1ddcce8ea4c056818646f4',
    description: 'APK decompile & rebuild (jar) — 随 APK 内置，已自动解压',
  },
  jadx: {
    tier: 'L1', type: 'archive-zip', install: 'online',
    // 轻资产化（2026-09-18 P2）：jadx（105M）移出 APK，改在线装（sha256 内置校验 + 镜像链）。
    source: 'https://github.com/skylot/jadx/releases/download/v1.5.0/jadx-1.5.0.zip',
    installPath: join(USR, 'share', 'jadx'),
    sha256: 'c5a713fa4800cbb9e6df85ced1bef95ba329040c95cb87d54465f108483e4ef9',
    description: 'DEX to Java decompiler (zip) — 需在线安装（tool_install jadx）',
  },
  radare2: {
    tier: 'L2', type: 'native', install: 'online',
    // 官方 Android aarch64 预编译（此前错用源码 tar.xz，装了只是份源码跑不起来）。
    // tar 顶层带 data/data/org.radare.radare2installer/radare2/ 前缀（4 层），解压需剥离。
    source: 'https://github.com/radareorg/radare2/releases/download/5.9.8/radare2-5.9.8-android-aarch64.tar.gz',
    installPath: join(USR, 'share', 'radare2'),
    stripComponents: 4,
    sha256: '28b07bbcf345fbb4a59a90e9a8c4dade6196a810c33f88516f11c4ae4cb12a47',
    description: 'Reverse engineering framework (CLI) — 需在线安装',
  },
  rizin: {
    tier: 'L2', type: 'native', install: 'online',
    // 官方资产名 rizin-v0.7.4-android-aarch64.tar.gz（arm64 原生安卓版）。
    // tar 顶层带 data/data/org.rizinorg.rizininstaller/ 前缀（3 层），解压需剥离。
    source: 'https://github.com/rizinorg/rizin/releases/download/v0.7.4/rizin-v0.7.4-android-aarch64.tar.gz',
    installPath: join(USR, 'share', 'rizin'),
    stripComponents: 3,
    sha256: 'ff9919dfbaf23d84e7199b7a5f9f6f0a7643a5fcf0741998d503859d4b0e69a1',
    description: 'Modern reverse engineering framework. 需在线安装。官方 android 资产为非 PIE 静态 ELF，Android 8+ 需经 root 通道（root_exec）执行',
    rootRequired: true,
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

/**
 * 镜像候选链（2026-09-18 国内加速，对齐 build-snapshot 的 npmjs→npmmirror 双镜像思路）：
 * 直连优先 → ghfast.top 前缀代理 → 可经 DSH_MIRROR_PREFIX env 覆盖/追加（逗号分隔，公益镜像无 SLA）。
 * 仅对 github.com/releases 资产生效（bitbucket 等前缀代理不支持）。
 * **sha256 期望值永远来自内置 TOOL_REGISTRY，绝不跟下载源走**——镜像被投毒即校验拒收。
 */
function candidateUrls(url) {
  const out = [url];
  if (/^https:\/\/(github\.com|objects\.githubusercontent\.com|codeload\.github\.com)\//.test(url)) {
    const prefixes = (process.env.DSH_MIRROR_PREFIX || 'https://ghfast.top/')
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of prefixes) {
      const joined = p.endsWith('/') ? p + url : p + '/' + url;
      if (joined !== url) out.push(joined);
    }
  }
  return out;
}

/** 按候选链依次尝试下载；全部失败抛最后一个错误。 */
async function downloadWithMirrors(url, dest, onProgress) {
  const urls = candidateUrls(url);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      if (i > 0) onProgress && onProgress(0, null); // 切镜像时复位进度显示
      await downloadFile(urls[i], dest, onProgress);
      return urls[i];
    } catch (err) {
      lastErr = err;
      try { const { unlinkSync } = await import('node:fs'); unlinkSync(dest); } catch {}
    }
  }
  throw new Error('所有下载源失败（' + urls.length + ' 个候选）：' + (lastErr && lastErr.message));
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
        await downloadWithMirrors(info.source, dl, (received, total) => setProgress(received, total));
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
    description: 'Install a development tool from the registry. apktool is built-in; jadx/radare2/rizin are online-install (download + sha256 verify + extract).',
    parameters: {
      name: { type: 'string', required: true, description: 'Tool name to install.' },
      force: { type: 'boolean', description: 'Reinstall over the existing tool (delete then re-download).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ name, force = false }) {
      const r = await service.install(name, { force });
      if (r.ok && TOOL_REGISTRY[name] && TOOL_REGISTRY[name].rootRequired) {
        r.note = '此工具为非 PIE 静态构建，Android 8+ 需经 root 通道（root_exec）执行';
      }
      return r;
    },
  });

  const upgradeTool = defineTool({
    name: 'tool_upgrade',
    description:
      'Upgrade an installed tool to the registry target version by force-reinstalling it ' +
      '(delete existing install, re-download, re-verify sha256, re-extract).',
    parameters: {
      name: { type: 'string', required: true, description: 'Tool name to upgrade.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ name }) { return service.install(name, { force: true }); },
  });

  const listTool = defineTool({
    name: 'tool_list',
    description: 'List all available tools with install status.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, tools: service.list() }; },
  });

  const statusTool = defineTool({
    name: 'tool_status',
    description:
      'Report the current or last tool install task progress (phase, bytes, percent, error). ' +
      'Poll this to track a long tool_install download/extract instead of blocking.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...service.status() }; },
  });

  return [installTool, upgradeTool, listTool, statusTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

/**
 * 首启工具链探针（0.13.3 P0，UPGRADE-PLAN.md §3-P0）：
 * 「每次 AI 都要修工具链」的根因不是工具缺失，而是环境没配对 + 无自检——
 * 工具文件在场但 jadx 报 tmpdir 不存在（坑39 openjdk 编译期路径）、radare2 报
 * libr_cons.so not found（LD_LIBRARY_PATH 缺 share/radare2/lib）。探针逐工具
 * 验证「落点在场 + --version 可跑」，结果写 .toolchain-probe.json 缓存
 * （文件供 linux-env 设置面与 AI 排障读取）。探测 env 与 shell-termux 的
 * env 语义一致（PATH 含 share 下各工具 bin、LD_LIBRARY_PATH 含 radare2 lib、
 * JAVA_TOOL_OPTIONS 双通道修 tmpdir）。
 */
const PROBE_TIMEOUT_MS = 20_000;

function probeEnv() {
  const home = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, '..')
    : '/data/data/com.dsharnessmobile.shell/files/home';
  const dshRoot = process.env.DSH_HOME || '/data/data/com.dsharnessmobile.shell/files/home/.dsh';
  const tmp = join(dshRoot, 'tmp');
  try { mkdirSync(tmp, { recursive: true }); } catch { /* 已在则忽略 */ }
  return {
    PATH: [join(USR, 'bin'), join(USR, 'share', 'jadx', 'bin'), join(USR, 'share', 'radare2', 'bin'), '/system/bin'].join(':'),
    LD_LIBRARY_PATH: [join(USR, 'lib'), join(USR, 'share', 'radare2', 'lib')].join(':'),
    HOME: home,
    PREFIX: USR,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    JAVA_TOOL_OPTIONS: `-Duser.home=${home} -Djava.io.tmpdir=${tmp}`,
  };
}

/** 注册表条目 → 实际可执行验证命令（落点在场 + 版本可读两关）。 */
function probeCommands() {
  return {
    apktool: { argv: ['java', '-jar', TOOL_REGISTRY.apktool.installPath, '--version'], path: TOOL_REGISTRY.apktool.installPath },
    jadx: { argv: [join(TOOL_REGISTRY.jadx.installPath, 'bin', 'jadx'), '--version'], path: join(TOOL_REGISTRY.jadx.installPath, 'bin', 'jadx') },
    radare2: { argv: [join(TOOL_REGISTRY.radare2.installPath, 'bin', 'radare2'), '-v'], path: join(TOOL_REGISTRY.radare2.installPath, 'bin', 'radare2') },
    rizin: { argv: [join(TOOL_REGISTRY.rizin.installPath, 'bin', 'rizin'), '-v'], path: join(TOOL_REGISTRY.rizin.installPath, 'bin', 'rizin') },
  };
}

async function probeOnce() {
  const cmds = probeCommands();
  const out = { ts: new Date().toISOString(), tools: {} };
  await Promise.all(Object.entries(cmds).map(async ([name, c]) => {
    if (!existsSync(c.path)) {
      out.tools[name] = { ok: false, status: 'missing', note: '落点不在场，可用 tool_install 安装' };
      return;
    }
    try {
      const { stdout } = await execFileAsync(c.argv[0], c.argv.slice(1), {
        env: probeEnv(), timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024,
      });
      // JAVA_TOOL_OPTIONS 会先向 stderr 打一行 "Picked up ..."，版本号在 stdout 首个非空行
      const version = (stdout || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
      out.tools[name] = { ok: true, status: 'ok', version };
    } catch (err) {
      out.tools[name] = { ok: false, status: 'broken', error: (err.message || String(err)).slice(0, 300) };
    }
  }));
  return out;
}

export function apply(ctx) {
  const service = buildService();
  ctx.provide('toolInstaller', service);
  for (const t of tools(service))
    ctx.tools.register(t);
  // 首启探针：延迟 15s（避开引擎启动高峰与插件树装配期），失败静默（只写报告不阻断）。
  const timer = setTimeout(() => {
    probeOnce().then((report) => {
      try {
        const dir = process.env.DSH_HOME || '/data/data/com.dsharnessmobile.shell/files/home/.dsh';
        writeFileSync(join(dir, '.toolchain-probe.json'), JSON.stringify(report, null, 2));
        const bad = Object.entries(report.tools).filter(([, v]) => !v.ok).map(([k]) => k);
        if (bad.length) console.log(`[tool-installer] probe: ${bad.join(',')} need attention (see .toolchain-probe.json)`);
        else console.log('[tool-installer] probe: all tools ok');
      } catch { /* 报告写失败不影响功能 */ }
    }).catch(() => { /* 探针失败不阻断 */ });
  }, 15_000);
  if (typeof timer.unref === 'function') timer.unref();
}
