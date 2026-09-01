/**
 * @dsh-android/dsh-android-dev-tools — Ubuntu PRoot 容器命令执行
 *
 * 通过 launch_ubuntu_proot.sh 进入 Ubuntu 24.04 ARM64 容器执行构建/开发命令。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function ubuntuEntry() {
  const home = process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
  return `${home}/.dsh/ubuntu-rootfs/proot-entry.sh`;
}

export function apply(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined) return;

  const disposers = [];

  disposers.push(tools.register({
    name: 'ubuntu_exec',
    description:
      'Execute a build or development command inside the Seagull Ubuntu PRoot container ' +
      '(apt/dpkg/gcc/cmake/python3/java toolchain). Typically used for APK reverse/build, ' +
      'C/C++ compilation, or Python tooling that needs a full distro.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run inside Ubuntu (bash -lc).' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000).' },
      },
      required: ['command'],
    },
    async execute({ command, timeoutMs = 120000 }) {
      const entry = ubuntuEntry();
      try {
        // proot-entry.sh [-c "command"]? — entry has no arg forwarding; use -c via bash.
        // launch script expects a command-like arg set; fall back to exec through it.
        const { stdout, stderr } = await execFileAsync('/bin/bash', [entry, '-lc', command], {
          timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
      }
    },
  }));

  disposers.push(tools.register({
    name: 'ubuntu_status',
    description: 'Report whether the Ubuntu PRoot rootfs is present and its size.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const { access } = await import('node:fs');
      const { stat } = await import('node:fs/promises');
      const entry = ubuntuEntry();
      const rootfs = entry.replace('/proot-entry.sh', '');
      try {
        await access(rootfs);
      } catch {
        return { ok: false, present: false, rootfs, message: 'Ubuntu rootfs 未装配，请先运行 ToolPkg/rootfs 安装。' };
      }
      const st = await stat(rootfs);
      return { ok: true, present: true, rootfs, sizeBytes: st.size };
    },
  }));

  ctx.effect(() => () => disposers.forEach((d) => d && d()));
}