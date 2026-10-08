/**
 * @dsh-android/dsh-android-apk-tools - APK decompile & rebuild tools.
 *
 * Seagull fork 执行模型（2026-09-02 复盘定案）：
 *   双路径执行 APK 工具链，均跑在宿主（Termux）——**不经 Ubuntu 容器**：
 *     1) 优先 usr/bin/{apktool,jadx,apksigner}（install-java-tools.sh 按需装配的 wrapper）
 *     2) 缺则回退 usr/share/{apktool,jadx}（apktool=APK 内置资产解压；jadx=tool_install 在线装，
 *        解到 usr/share/jadx 同构布局）+ usr/bin/java
 *   工具就绪门槛：java（openjdk-21）必须在；apktool/jadx/apksigner 任一路径可用。
 *   全缺时返回明确引导（install-java-tools.sh），不静默失败。
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, appendFileSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

/** root 通道（KernelSU/Magisk）：apk_install 走 su -c pm install 装回设备，补全改 APK 闭环。 */
const ROOT_SU = '/system/bin/su';

/** 干净环境：避免 termux-exec LD_PRELOAD 污染 su 子进程（坑 22）。 */
function cleanEnv() {
  return {
    PATH: '/system/bin:/system/xbin:/system/usr/bin',
    LD_LIBRARY_PATH: '/system/lib64:/system/lib',
    LD_PRELOAD: '',
  };
}

async function runRoot(args, timeout, action) {
  const command = args[0] === '-c' ? String(args[1] ?? '') : args.join(' ');
  try {
    const { stdout, stderr } = await execFileAsync(ROOT_SU, args, {
      env: cleanEnv(), timeout: timeout || 120000, maxBuffer: 16 * 1024 * 1024,
    });
    auditRoot(action || 'apk-install', command, 'ok');
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    auditRoot(action || 'apk-install', command, 'fail');
    return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
  }
}

/** root 提权审计（对齐 root-ops/bridge：files/audit/audit.ndjson；命令不落全文）。 */
function auditRoot(action, command, result) {
  try {
    const dir = process.env.DSH_ROOT_AUDIT_PATH ?? '/data/user/0/com.dsharnessmobile.shell/files/audit';
    mkdirSync(dir, { recursive: true });
    const cmd = String(command ?? '');
    const entry = {
      ts: new Date().toISOString(),
      action,
      tool: 'apk-tools',
      result,
      cmdLen: cmd.length,
      cmdHash: createHash('sha256').update(cmd).digest('hex').slice(0, 16),
      cmdPreview: cmd.slice(0, 200),
    };
    appendFileSync(join(dir, 'audit.ndjson'), JSON.stringify(entry) + '\n');
    // 滚动截断：>2MB 保留尾部 500 行（2026-10-08 真机报告 B5；对齐 bridge/root-ops）
    try {
      const file = join(dir, 'audit.ndjson');
      if (statSync(file).size > 2 * 1024 * 1024) {
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.slice(-500).join('\n'));
      }
    } catch { /* 截断失败不阻断 */ }
  } catch { /* 审计失败不阻断 */ }
}

/** 单引号包裹 shell 参数，内部单引号按 POSIX 规则转义，防路径注入。 */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function runtimePrefix() {
  return process.env.TERMUX__PREFIX || process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr';
}

/** 宿主 home 目录（app 域 files/home）。 */
function homeDir() {
  return process.env.HOME || runtimePrefix().replace(/\/usr\/?$/, '') + '/home';
}

/**
 * Java 系工具统一 env：Termux openjdk 的 user.home / java.io.tmpdir 不读 HOME/TMPDIR env
 * （编译期硬编码 Termux 路径），必须经 JAVA_TOOL_OPTIONS 显式 -D 覆盖，否则 apktool
 * 建 framework 目录、buildResources createTempFile 均失败（坑 39）。
 */
function javaEnv() {
  const home = homeDir();
  return {
    ...process.env,
    JAVA_TOOL_OPTIONS: '-Duser.home=' + home + ' -Djava.io.tmpdir=' + home + '/tmp',
  };
}
function usrBin(name) { return runtimePrefix() + '/bin/' + name; }
function usrShare(name) { return runtimePrefix() + '/share/' + name; }

/** java 运行时路径：usr/bin/java（install-java-tools 或快照装配）。 */
function javaBin() { return usrBin('java'); }
/** keytool 运行时路径（openjdk-21，随 install-java-tools 落 usr/bin）。 */
function keytoolBin() { return usrBin('keytool'); }

/** debug keystore 固定落点（files/usr/.dsh/keystore/debug.keystore）。 */
function debugKeystoreDir() { return runtimePrefix() + '/.dsh/keystore'; }
function debugKeystore() { return debugKeystoreDir() + '/debug.keystore'; }

/**
 * 通用 keystore 生成：alias/storePass/keyPass/cn/outPath 可自定义；缺省即标准 Android debug keystore。
 * 已存在则直接复用（幂等）。
 */
async function genKeystore({ alias = 'androiddebugkey', storePass = 'android', keyPass = 'android', cn = 'CN=Android Debug,O=Android,C=US', outPath } = {}) {
  const ks = outPath || debugKeystore();
  if (existsSync(ks)) return { ok: true, keystore: ks, existed: true };
  if (!existsSync(keytoolBin())) {
    return { ok: false, error: 'keytool 不可用：请先运行 install-java-tools.sh 安装 openjdk-21' };
  }
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(ks), { recursive: true });
  const args = [
    '-genkeypair', '-v',
    '-keystore', ks,
    '-alias', alias,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', storePass, '-keypass', keyPass,
    '-dname', cn,
  ];
  try {
    await execFileAsync(keytoolBin(), args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: javaEnv() });
    return { ok: true, keystore: ks };
  } catch (err) {
    return { ok: false, error: 'keytool 生成 keystore 失败：' + err.message };
  }
}

/** 确保 debug keystore 存在（genKeystore 缺省参数即 debug）。 */
async function ensureDebugKeystore() {
  return genKeystore();
}

/**
 * 解析某个工具的可执行调用：
 * 优先 usr/bin wrapper（install-java-tools.sh），回退 usr/share 内置 jar + java。
 * @param cpMain 非空时用 `java -cp <jar> <cpMain>`（jadx 等有主类的），否则 `java -jar <jar>`。
 * @returns {cmd, args, needsJava} 或 null（不可用）。
 */
function resolveTool(name, jarRel, cpMain) {
  const wrapper = usrBin(name);
  if (existsSync(wrapper)) return { cmd: wrapper, args: [], needsJava: false };
  const p = usrShare(jarRel);
  if (existsSync(javaBin()) && existsSync(p)) {
    if (cpMain) return { cmd: javaBin(), args: ['-cp', p, cpMain], needsJava: true };
    return { cmd: javaBin(), args: ['-jar', p], needsJava: true };
  }
  return null;
}

function toolReady() {
  const missing = [];
  if (!existsSync(javaBin())) missing.push('java (openjdk-21)');
  // jadx 是官方 zip 的 bin/jadx 启动脚本（非 jar），离线兜底须走 `java -cp lib/*.jar jadx.cli.JadxCLI`。
  const need = [
    ['apktool', 'apktool/apktool.jar', null],
    ['jadx', 'jadx/lib/jadx-1.5.0-all.jar', 'jadx.cli.JadxCLI'],
    ['apksigner', 'apksigner/apksigner.jar', null],
  ];
  for (const [name, jarRel, cpMain] of need) {
    if (resolveTool(name, jarRel, cpMain) === null) missing.push(name);
  }
  return missing;
}

function installGuide() {
  return '缺少 ' + toolReady().join('、') + '。请先运行：install-java-tools.sh（快照 usr/bin 内，按需安装器）；jadx 亦可经 tool_install jadx 在线安装（轻资产：jadx 不再随 APK 内置）';
}

async function runTool(name, jarRel, args, timeout, cpMain) {
  const t = resolveTool(name, jarRel, cpMain);
  if (t === null) return { ok: false, error: installGuide() };
  try {
    const { stdout, stderr } = await execFileAsync(t.cmd, [...t.args, ...args], {
      timeout: timeout || 300000, maxBuffer: 64 * 1024 * 1024, env: javaEnv(),
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    // jadx 在遇部分非致命资源/类解析警告时退出码为 3（或 2），但源码依然完整解出，不应判死
    if (name === 'jadx' && (err.code === 3 || err.code === 2)) {
      return { ok: true, stdout: String(err.stdout || '').trim(), stderr: String(err.stderr || '').trim(), warning: 'jadx finished with non-fatal errors' };
    }
    return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
  }
}

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

/** 解析 aapt2 dump badging 输出为结构化字段。 */
function parseBadging(badging) {
  const info = { permissions: [], nativeAbis: [] };
  const pkgMatch = badging.match(/^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/m);
  if (pkgMatch) {
    info.packageName = pkgMatch[1];
    info.versionCode = pkgMatch[2];
    info.versionName = pkgMatch[3];
  }
  const sdk = badging.match(/^sdkVersion:'([^']*)'/m);
  if (sdk) info.minSdkVersion = sdk[1];
  const target = badging.match(/^targetSdkVersion:'([^']*)'/m);
  if (target) info.targetSdkVersion = target[1];
  const label = badging.match(/^application-label:'([^']*)'/m);
  if (label) info.label = label[1];
  info.permissions = [...badging.matchAll(/^uses-permission: name='([^']*)'/gm)].map((m) => m[1]);
  const abis = [...badging.matchAll(/^native-code: (.*)$/gm)];
  if (abis.length > 0) {
    info.nativeAbis = abis.flatMap((m) => m[1].split(' ').map((s) => s.replace(/'/g, '')).filter(Boolean));
  }
  return info;
}

function tools() {
  const decompileTool = defineTool({
    name: 'apk_decompile',
    description:
      'Decompile an APK to smali (apktool) or Java source (jadx), or both. ' +
      'Runs on the host Termux environment (java-based); requires java + apktool/jadx ' +
      '(install-java-tools.sh or built-in jar assets).',
    parameters: {
      apkPath: { type: 'string', required: true, description: 'Path to the target APK.' },
      outDir: { type: 'string', required: true, description: 'Output directory.' },
      mode: { type: 'string', enum: ['apktool', 'jadx', 'both'], description: 'Decompile engine.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ apkPath, outDir, mode = 'apktool' }) {
      const missing = toolReady();
      if (missing.length > 0) return { ok: false, guidance: installGuide(), missing };
      if (mode === 'apktool') return runTool('apktool', 'apktool/apktool.jar', ['d', apkPath, '-o', outDir, '-f']);
      if (mode === 'jadx') return runTool('jadx', 'jadx/lib/jadx-1.5.0-all.jar', ['-d', outDir, apkPath], 300000, 'jadx.cli.JadxCLI');
      const r1 = await runTool('apktool', 'apktool/apktool.jar', ['d', apkPath, '-o', outDir + '/smali', '-f']);
      if (!r1.ok) return r1;
      return runTool('jadx', 'jadx/lib/jadx-1.5.0-all.jar', ['-d', outDir + '/src', apkPath], 300000, 'jadx.cli.JadxCLI');
    },
  });

  const buildSignTool = defineTool({
    name: 'apk_build_sign',
    description:
      'Rebuild an APK project directory (apktool b), then zipalign and debug-sign it (apksigner). ' +
      'Requires java + apktool + apksigner (install-java-tools.sh or built-in assets).',
    parameters: {
      srcDir: { type: 'string', required: true, description: 'The APK project directory (from apk_decompile apktool).' },
      outApk: { type: 'string', required: true, description: 'Output signed APK path.' },
      keystore: { type: 'string', description: 'Custom keystore path (default: auto-generated debug keystore).' },
      ksAlias: { type: 'string', description: 'Key alias (default androiddebugkey).' },
      ksPass: { type: 'string', description: 'Keystore password (default android).' },
      keyPass: { type: 'string', description: 'Key password (default android).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ srcDir, outApk, keystore, ksAlias = 'androiddebugkey', ksPass = 'android', keyPass = 'android' }) {
      const missing = toolReady();
      if (missing.length > 0) return { ok: false, guidance: installGuide(), missing };
      const unsigned = outApk + '.unsigned.apk';
      const aligned = outApk + '.aligned.apk';
      const r1 = await runTool('apktool', 'apktool/apktool.jar', ['b', srcDir, '-o', unsigned]);
      if (!r1.ok) return r1;
      let keystorePath = keystore;
      if (!keystorePath) {
        const ks = await ensureDebugKeystore();
        if (!ks.ok) return ks;
        keystorePath = ks.keystore;
      } else if (!existsSync(keystorePath)) {
        return { ok: false, error: 'keystore 不存在：' + keystorePath };
      }
      // zipalign 可选（usr/bin 或 usr/share；无则直接签未对齐包）
      const z = usrBin('zipalign');
      const signArgs = ['sign', '--ks', keystorePath, '--ks-key-alias', ksAlias, '--ks-pass', 'pass:' + ksPass, '--key-pass', 'pass:' + keyPass, '--out', outApk];
      if (existsSync(z)) {
        const r2 = await runTool('zipalign', 'zipalign/zipalign', ['-v', '-p', '4', unsigned, aligned]);
        if (!r2.ok) return r2;
        const r3 = await runTool('apksigner', 'apksigner/apksigner.jar', [...signArgs, aligned]);
        if (r3.ok) { const { rmSync } = await import('node:fs'); try { rmSync(unsigned); rmSync(aligned); } catch {} }
        return r3;
      }
      const r3 = await runTool('apksigner', 'apksigner/apksigner.jar', [...signArgs, unsigned]);
      if (r3.ok) { const { rmSync } = await import('node:fs'); try { rmSync(unsigned); } catch {} }
      return r3;
    },
  });

  const infoTool = defineTool({
    name: 'apk_info',
    description:
      'Inspect an APK metadata: package name, version, min/target SDK, permissions, native ABIs, ' +
      'and signing certificate. Uses aapt2 dump badging + apksigner verify --print-certs (host Termux).',
    parameters: {
      apkPath: { type: 'string', required: true, description: 'Path to the target APK.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ apkPath }) {
      const aapt2 = usrBin('aapt2');
      if (!existsSync(aapt2)) {
        return { ok: false, guidance: installGuide(), missing: ['aapt2'] };
      }
      let badging;
      try {
        const { stdout } = await execFileAsync(aapt2, ['dump', 'badging', apkPath], {
          timeout: 60000, maxBuffer: 16 * 1024 * 1024,
        });
        badging = stdout;
      } catch (err) {
        return { ok: false, error: 'aapt2 dump badging 失败：' + err.message + (err.stderr ? ' ' + String(err.stderr).trim() : '') };
      }
      const info = parseBadging(badging || '');
      const signer = resolveTool('apksigner', 'apksigner/apksigner.jar');
      if (signer) {
        try {
          const { stdout } = await execFileAsync(signer.cmd, [...signer.args, 'verify', '--print-certs', apkPath], {
            timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: javaEnv(),
          });
          info.signingCertificates = (stdout || '').trim();
        } catch (err) {
          info.signingCertificates = 'verify 失败：' + err.message;
        }
      } else {
        info.signingCertificates = 'apksigner 不可用，跳过签名校验';
      }
      return { ok: true, ...info };
    },
  });

  const keystoreGenTool = defineTool({
    name: 'keystore_gen',
    description:
      'Generate a signing keystore (keytool). Defaults to a standard Android debug keystore; ' +
      'customize alias/storePass/keyPass/cn/outPath for release signing.',
    parameters: {
      alias: { type: 'string', description: 'Key alias (default androiddebugkey).' },
      storePass: { type: 'string', description: 'Keystore password (default android).' },
      keyPass: { type: 'string', description: 'Key password (default android).' },
      cn: { type: 'string', description: 'Distinguished name CN (default CN=Android Debug,O=Android,C=US).' },
      outPath: { type: 'string', description: 'Output keystore path (default usr/.dsh/keystore/debug.keystore).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute(params = {}) {
      return genKeystore(params);
    },
  });

  const installTool = defineTool({
    name: 'apk_install',
    description:
      'Install a signed APK onto the device via root (su -c pm install). Completes the ' +
      'decompile → rebuild → sign → install loop. Requires /system/bin/su (KernelSU/Magisk). ' +
      'apkPath must be an absolute device-visible path.',
    parameters: {
      apkPath: { type: 'string', required: true, description: 'Absolute path to the signed APK.' },
      flags: { type: 'string', description: 'Extra pm install flags (default "-r -t"; e.g. "-r -d" to downgrade).' },
      user: { type: 'string', description: 'Target user id (default none; e.g. "0").' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ apkPath, flags = '-r -t', user }) {
      // flags/user 走白名单校验，防命令注入（仅 pm install 合法 flag 字符 / 数字用户）。
      if (!/^[a-zA-Z0-9\-\s]*$/.test(flags)) {
        return { ok: false, error: 'flags 仅允许字母/数字/连字符/空格' };
      }
      if (user !== undefined && !/^\d+$/.test(String(user))) {
        return { ok: false, error: 'user 仅允许数字' };
      }
      const userArg = user ? `--user ${user}` : '';
      const cmd = `/system/bin/pm install ${flags} ${userArg} ${shellQuote(apkPath)} 2>&1`;
      const r = await runRoot(['-c', cmd], null, 'apk-install');
      // pm install 失败经 stdout「Failure [reason]」而非退出码反馈（pm 是 java 进程，恒 exit 0）。
      const success = r.ok && /^Success\b/m.test(r.stdout || '');
      if (r.ok) {
        r.success = success;
        if (!success) r.error = (r.stdout || '').split('\n').find((l) => l.trim()) || 'unknown install failure';
      }
      return r;
    },
  });

  const smaliFindTool = defineTool({
    name: 'smali_find',
    description:
      'Search decompiled smali source (apktool output) for a string or ERE regex, returning ' +
      'file:line matches. Use it to locate code to patch before smali_edit.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Root dir of smali source (e.g. apktool output).' },
      pattern: { type: 'string', required: true, description: 'String or ERE regex to search (grep -E).' },
      maxResults: { type: 'number', description: 'Max matches to return (default 50).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ dir, pattern, maxResults = 50 }) {
      if (!existsSync(dir)) return { ok: false, error: 'smali 目录不存在：' + dir };
      const n = Math.max(1, Math.min(Number(maxResults) || 50, 500));
      try {
        const { stdout } = await execFileAsync('grep', ['-rEn', '--include=*.smali', '--', pattern, dir], {
          timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        });
        const matches = (stdout || '').split('\n').filter(Boolean).slice(0, n).map((line) => {
          const i = line.indexOf(':');
          const rest = line.slice(i + 1);
          const j = rest.indexOf(':');
          return { file: line.slice(0, i), lineNumber: Number(rest.slice(0, j)), text: rest.slice(j + 1) };
        });
        return { ok: true, count: matches.length, matches };
      } catch (err) {
        if (err.code === 1) return { ok: true, count: 0, matches: [] };
        return { ok: false, error: 'grep 失败：' + err.message };
      }
    },
  });

  const smaliEditTool = defineTool({
    name: 'smali_edit',
    description:
      'Edit a smali file by replacing a literal string (find) with another (replace). Literal ' +
      '(no regex); writes back in place and keeps a .bak backup. Use smali_find first to locate.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the smali file to edit.' },
      find: { type: 'string', required: true, description: 'Literal text to replace.' },
      replace: { type: 'string', required: true, description: 'Replacement text.' },
      all: { type: 'boolean', description: 'Replace all occurrences (default false; find must be unique).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ file, find, replace, all = false }) {
      if (!find) return { ok: false, error: 'find 不能为空' };
      if (!existsSync(file)) return { ok: false, error: '文件不存在：' + file };
      const { readFileSync, writeFileSync, copyFileSync } = await import('node:fs');
      const content = readFileSync(file, 'utf8');
      const count = content.split(find).length - 1;
      if (count === 0) return { ok: false, error: '未找到目标文本：' + find.slice(0, 80) };
      if (!all && count > 1) {
        return { ok: false, error: `目标文本出现 ${count} 次，请提供更精确的 find 或设置 all=true` };
      }
      try { copyFileSync(file, file + '.bak'); } catch {}
      // 用函数作 replace 第二参，避免 $ 序列（$& $1 等）在 smali 代码里被特殊展开。
      const next = all ? content.split(find).join(replace) : content.replace(find, () => replace);
      writeFileSync(file, next, 'utf8');
      return { ok: true, replaced: all ? count : 1, backup: file + '.bak' };
    },
  });

  return [decompileTool, buildSignTool, infoTool, keystoreGenTool, installTool, smaliFindTool, smaliEditTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  for (const t of tools())
    ctx.tools.register(t);
}
