import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export function apply(ctx) {
  const rootOpsService = {
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
        return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
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
    },

    async dumpUI() {
      const dumpPath = '/data/local/tmp/window_dump.xml';
      const res = await this.exec(`/system/bin/uiautomator dump ${dumpPath} && /system/bin/cat ${dumpPath}`);
      return res;
    },

    async inputTap(x, y) {
      return this.exec(`/system/bin/input tap ${x} ${y}`);
    },

    async inputSwipe(x1, y1, x2, y2, durationMs = 300) {
      return this.exec(`/system/bin/input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
    },

    async inputText(text) {
      return this.exec(`/system/bin/input text "${text.replace(/"/g, '\\"')}"`);
    },

    async inputKey(keyCode) {
      return this.exec(`/system/bin/input keyevent ${keyCode}`);
    }
  };

  ctx.provide('rootOps', rootOpsService);

  // 注册 Root 命令执行工具
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
      return await rootOpsService.exec(command);
    }
  });

  // 注册 UI 自动化与屏幕操控工具
  ctx.tools?.register({
    name: 'device_ui_control',
    description: 'Control Android device UI via Root (dump hierarchy, tap, swipe, input text/keys)',
    parameters: {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['dump_ui', 'tap', 'swipe', 'input_text', 'keyevent'],
          description: 'UI action to perform'
        },
        x: { type: 'number', description: 'X coordinate for tap' },
        y: { type: 'number', description: 'Y coordinate for tap' },
        x2: { type: 'number', description: 'Target X coordinate for swipe' },
        y2: { type: 'number', description: 'Target Y coordinate for swipe' },
        text: { type: 'string', description: 'Text string to input' },
        keyCode: { type: 'number', description: 'Android KeyEvent code (e.g., 3=HOME, 4=BACK, 66=ENTER)' }
      },
      required: ['action']
    },
    async execute({ action, x, y, x2, y2, text, keyCode }) {
      switch (action) {
        case 'dump_ui':
          return await rootOpsService.dumpUI();
        case 'tap':
          return await rootOpsService.inputTap(x, y);
        case 'swipe':
          return await rootOpsService.inputSwipe(x, y, x2, y2);
        case 'input_text':
          return await rootOpsService.inputText(text);
        case 'keyevent':
          return await rootOpsService.inputKey(keyCode);
        default:
          return { ok: false, error: `Unknown action: ${action}` };
      }
    }
  });
}
