import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export function apply(ctx) {
  // 注册 APK 逆向与编译工具集
  ctx.tools?.register({
    name: 'apk_decompile',
    description: 'Decompile an Android APK into Smali resources (via Apktool) or Java source (via JADX)',
    parameters: {
      type: 'object',
      properties: {
        apkPath: { type: 'string', description: 'Path to target APK file' },
        outDir: { type: 'string', description: 'Output directory for decompiled source' },
        mode: { type: 'string', enum: ['apktool', 'jadx', 'both'], description: 'Decompile engine mode' }
      },
      required: ['apkPath', 'outDir']
    },
    async execute({ apkPath, outDir, mode = 'apktool' }) {
      const proot = `${process.env.HOME}/.dsh/ubuntu-rootfs/proot-entry.sh`;
      let cmd = '';
      if (mode === 'apktool') {
        cmd = `/bin/bash ${proot} -c "apktool d '${apkPath}' -o '${outDir}' -f"`;
      } else if (mode === 'jadx') {
        cmd = `/bin/bash ${proot} -c "jadx -d '${outDir}' '${apkPath}'"`;
      } else {
        cmd = `/bin/bash ${proot} -c "apktool d '${apkPath}' -o '${outDir}/smali' -f && jadx -d '${outDir}/src' '${apkPath}'"`;
      }

      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 });
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? err.stderr.trim() : '' };
      }
    }
  });

  ctx.tools?.register({
    name: 'apk_build_sign',
    description: 'Rebuild an APK project directory and automatically zipalign & debug-sign it',
    parameters: {
      type: 'object',
      properties: {
        srcDir: { type: 'string', description: 'The modified APK project directory' },
        outApk: { type: 'string', description: 'Path for the output signed APK' }
      },
      required: ['srcDir', 'outApk']
    },
    async execute({ srcDir, outApk }) {
      const proot = `${process.env.HOME}/.dsh/ubuntu-rootfs/proot-entry.sh`;
      const unsigned = `${outApk}.unsigned.apk`;
      const aligned = `${outApk}.aligned.apk`;
      const cmd = `/bin/bash ${proot} -c "
        apktool b '${srcDir}' -o '${unsigned}' && \
        zipalign -v -p 4 '${unsigned}' '${aligned}' && \
        apksigner sign --ks /root/.dsh/keystore/debug.keystore --ks-pass pass:android --out '${outApk}' '${aligned}' && \
        rm -f '${unsigned}' '${aligned}'
      "`;

      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 });
        return { ok: true, outApk, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? err.stderr.trim() : '' };
      }
    }
  });
}
