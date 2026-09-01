import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export function apply(ctx) {
  // 注册 root 执行服务，通过纯净 PATH 与 LD_PRELOAD 屏蔽 termux-exec 污染
  ctx.provide('rootOps', {
    async exec(command, opts = {}) {
      const cleanEnv = {
        PATH: '/system/bin:/system/xbin:/data/user/0/com.seagull.devstudio/files/usr/bin',
        LD_LIBRARY_PATH: '/system/lib64:/system/lib',
        LD_PRELOAD: '',
        ...opts.env
      };

      const suCmd = `/system/bin/su -c "${command.replace(/"/g, '\\"')}"`;
      try {
        const { stdout, stderr } = await execAsync(suCmd, { env: cleanEnv, timeout: opts.timeout || 30000 });
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? err.stderr.trim() : '' };
      }
    },

    async readPrivFile(path) {
      return this.exec(`/system/bin/cat "${path}"`);
    },

    async listPrivDir(path) {
      return this.exec(`/system/bin/ls -la "${path}"`);
    },

    async getProcessMaps(pid) {
      return this.exec(`/system/bin/cat /proc/${pid}/maps`);
    }
  });

  // 注册为 Agent 工具
  ctx.tools?.register({
    name: 'root_exec',
    description: 'Execute commands with full Root (uid=0) privileges in a clean environment',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute as root' }
      },
      required: ['command']
    },
    async execute({ command }) {
      const rootOps = ctx.get('rootOps');
      return await rootOps.exec(command);
    }
  });
}
