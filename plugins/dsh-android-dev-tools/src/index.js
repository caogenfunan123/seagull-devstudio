/**
 * @dsh-android/dsh-android-dev-tools — Ubuntu PRoot 容器命令执行
 *
 * 通过 proot-entry.sh 进入 Ubuntu 24.04 ARM64 容器执行构建/开发命令。
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

function ubuntuEntry() {
  const home = process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
  return `${home}/.dsh/ubuntu-rootfs/proot-entry.sh`;
}

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

function tools() {
  const execTool = defineTool({
    name: 'ubuntu_exec',
    description:
      'Execute a build or development command inside the Seagull Ubuntu container ' +
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
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ command, timeoutMs = 120000 }) {
      const entry = ubuntuEntry();
      try {
        const { stdout, stderr } = await execFileAsync('/bin/bash', [entry, '-lc', command], {
          timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
      }
    },
  });

  const statusTool = defineTool({
    name: 'ubuntu_status',
    description: 'Report whether the Ubuntu rootfs is present and its size.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
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
  });

  return [execTool, statusTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  for (const t of tools())
    ctx.tools.register(t);
}
