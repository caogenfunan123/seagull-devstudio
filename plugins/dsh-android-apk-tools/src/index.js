/**
 * @dsh-android/dsh-android-apk-tools - APK decompile & rebuild tools.
 * Runs apktool/jadx/zipalign/apksigner inside the Ubuntu container.
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

function prootEntry() {
  const home = process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
  return home + '/.dsh/ubuntu-rootfs/proot-entry.sh';
}

async function runInUbuntu(cmd, timeout) {
  const entry = prootEntry();
  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', [entry, '-lc', cmd], {
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
    description: 'Decompile an APK to smali (apktool) or Java source (jadx), or both.',
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
      let cmd;
      if (mode === 'apktool') cmd = 'apktool d ' + JSON.stringify(apkPath) + ' -o ' + JSON.stringify(outDir) + ' -f';
      else if (mode === 'jadx') cmd = 'jadx -d ' + JSON.stringify(outDir) + ' ' + JSON.stringify(apkPath);
      else cmd = 'apktool d ' + JSON.stringify(apkPath) + ' -o ' + JSON.stringify(outDir + '/smali') + ' -f && jadx -d ' + JSON.stringify(outDir + '/src') + ' ' + JSON.stringify(apkPath);
      return runInUbuntu(cmd);
    },
  });

  const buildSignTool = defineTool({
    name: 'apk_build_sign',
    description: 'Rebuild an APK project directory, then zipalign and debug-sign it.',
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
      const unsigned = JSON.stringify(outApk + '.unsigned.apk');
      const aligned = JSON.stringify(outApk + '.aligned.apk');
      const out = JSON.stringify(outApk);
      const src = JSON.stringify(srcDir);
      const keystore = '/root/.dsh/keystore/debug.keystore';
      const cmd = 'apktool b ' + src + ' -o ' + unsigned +
        ' && zipalign -v -p 4 ' + unsigned + ' ' + aligned +
        ' && apksigner sign --ks ' + keystore + ' --ks-pass pass:android --out ' + out + ' ' + aligned +
        ' && rm -f ' + unsigned + ' ' + aligned;
      const r = await runInUbuntu(cmd);
      return r.ok ? { ok: true, outApk } : r;
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
