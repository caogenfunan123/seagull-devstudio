import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export function apply(ctx) {
  ctx.tools?.register({
    name: 'ubuntu_exec',
    description: 'Execute build or dev commands inside the Ubuntu ARM64 PRoot container',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute in Ubuntu environment' }
      },
      required: ['command']
    },
    async execute({ command }) {
      const entry = `${process.env.HOME}/.dsh/ubuntu-rootfs/proot-entry.sh`;
      try {
        const { stdout, stderr } = await execAsync(`/bin/bash ${entry} -c "${command.replace(/"/g, '\\"')}"`, {
          timeout: 60000
        });
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? err.stderr.trim() : '' };
      }
    }
  });
}
