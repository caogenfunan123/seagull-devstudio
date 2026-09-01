/**
 * @dsh-android/dsh-android-apk-tools - APK decompile & rebuild tools.
 *
 * Seagull fork 执行模型（2026-09-02 复盘定案）：
 *   双路径执行 APK 工具链，均跑在宿主（Termux）——**不经 Ubuntu 容器**：
 *     1) 优先 usr/bin/{apktool,jadx,apksigner}（install-java-tools.sh 按需装配的 wrapper）
 *     2) 缺则回退 usr/share/{apktool,jadx}（assets/tools 内置 jar，离线兜底）+ usr/bin/java
 *   工具就绪门槛：java（openjdk-21）必须在；apktool/jadx/apksigner 任一路径可用。
 *   全缺时返回明确引导（install-java-tools.sh），不静默失败。
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

function runtimePrefix() {
  return process.env.TERMUX__PREFIX || process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr';
}
function usrBin(name) { return runtimePrefix() + '/bin/' + name; }
function usrShare(name) { return runtimePrefix() + '/share/' + name; }

/** java 运行时路径：usr/bin/java（install-java-tools 或快照装配）。 */
function javaBin() { return usrBin('java'); }

/**
 * 解析某个工具的可执行调用：
 * 优先 usr/bin wrapper（install-java-tools.sh），回退 usr/share 内置 jar + java。
 * @returns {cmd, args, needsJava} 或 null（不可用）。
 */
function resolveTool(name, jarRel) {
  const wrapper = usrBin(name);
  if (existsSync(wrapper)) return { cmd: wrapper, args: [], needsJava: false };
  const jar = usrShare(jarRel);
  if (existsSync(javaBin()) && existsSync(jar)) {
    return { cmd: javaBin(), args: ['-jar', jar], needsJava: true };
  }
  return null;
}

function toolReady() {
  const missing = [];
  if (!existsSync(javaBin())) missing.push('java (openjdk-21)');
  const need = [
    ['apktool', 'apktool/apktool.jar'],
    ['jadx', 'jadx/bin/jadx'],
    ['apksigner', 'apksigner/apksigner.jar'],
  ];
  for (const [name, jarRel] of need) {
    if (resolveTool(name, jarRel) === null) missing.push(name);
  }
  return missing;
}

function installGuide() {
  return '缺少 ' + toolReady().join('、') + '。请先运行：install-java-tools.sh（快照 usr/bin 内，按需安装器）；或确认内置 jar 资产已解压';
}

async function runTool(name, jarRel, args, timeout) {
  const t = resolveTool(name, jarRel);
  if (t === null) return { ok: false, error: installGuide() };
  try {
    const { stdout, stderr } = await execFileAsync(t.cmd, [...t.args, ...args], {
      timeout: timeout || 300000, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
  }
}

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

function tools() {
  const decompileTool = defineTool({
    name: 'apk_decompile',
    description:
      'Decompile an APK to smali (apktool) or Java source (jadx), or both. ' +
      'Runs on the host Termux environment (java-based); requires java + apktool/jadx ' +
      '(install-java-tools.sh or built-in jar assets).',
    parameters: {
      type: 'object',
      properties: {
        apkPath: { type: 'string', description: 'Path to the target APK.' },
        outDir: { type: 'string', description: 'Output directory.' },
        mode: { type: 'string', enum: ['apktool', 'jadx', 'both'], description: 'Decompile engine.' },
      },
      required: ['apkPath', 'outDir'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ apkPath, outDir, mode = 'apktool' }) {
      const missing = toolReady();
      if (missing.length > 0) return { ok: false, guidance: installGuide(), missing };
      if (mode === 'apktool') return runTool('apktool', 'apktool/apktool.jar', ['d', apkPath, '-o', outDir, '-f']);
      if (mode === 'jadx') return runTool('jadx', 'jadx/bin/jadx', ['-d', outDir, apkPath]);
      const r1 = await runTool('apktool', 'apktool/apktool.jar', ['d', apkPath, '-o', outDir + '/smali', '-f']);
      if (!r1.ok) return r1;
      return runTool('jadx', 'jadx/bin/jadx', ['-d', outDir + '/src', apkPath]);
    },
  });

  const buildSignTool = defineTool({
    name: 'apk_build_sign',
    description:
      'Rebuild an APK project directory (apktool b), then zipalign and debug-sign it (apksigner). ' +
      'Requires java + apktool + apksigner (install-java-tools.sh or built-in assets).',
    parameters: {
      type: 'object',
      properties: {
        srcDir: { type: 'string', description: 'The APK project directory (from apk_decompile apktool).' },
        outApk: { type: 'string', description: 'Output signed APK path.' },
      },
      required: ['srcDir', 'outApk'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ srcDir, outApk }) {
      const missing = toolReady();
      if (missing.length > 0) return { ok: false, guidance: installGuide(), missing };
      const unsigned = outApk + '.unsigned.apk';
      const aligned = outApk + '.aligned.apk';
      const r1 = await runTool('apktool', 'apktool/apktool.jar', ['b', srcDir, '-o', unsigned]);
      if (!r1.ok) return r1;
      const keystore = runtimePrefix() + '/.dsh/keystore/debug.keystore';
      // zipalign 可选（usr/bin 或 usr/share；无则直接签未对齐包）
      const z = usrBin('zipalign');
      const signArgs = ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--out', outApk];
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

  return [decompileTool, buildSignTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  for (const t of tools())
    ctx.tools.register(t);
}
