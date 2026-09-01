/**
 * @dsh-android/dsh-android-root-ops — Root 操作服务与工具
 *
 * 经 root (uid=0) 执行系统命令、读写任意文件、操作设备 UI。
 * 仅在用户开启「关闭沙盒/超级用户」(danger-full-access) 预置时注入 root 感知提示。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT_SU = '/system/bin/su';

/** 干净环境：避免 termux-exec LD_PRELOAD 污染 su 子进程（坑 22）。 */
function cleanEnv(extra = {}) {
  return {
    PATH: '/system/bin:/system/xbin:/system/usr/bin',
    LD_LIBRARY_PATH: '/system/lib64:/system/lib',
    LD_PRELOAD: '',
    ...extra,
  };
}

async function runSu(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(ROOT_SU, args, {
      env: cleanEnv(), timeout: opts.timeout || 30000, maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
  }
}

export function apply(ctx) {
  const tools = ctx.get('tools');
  if (tools !== undefined) {
    const disposers = [];

    disposers.push(tools.register({
      name: 'root_exec',
      description:
        'Execute a shell command with full root (uid=0) privileges in a clean Android environment. ' +
        'Use for system-wide read/write, app data access, /proc inspection, or privileged patching.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run as root.' },
        },
        required: ['command'],
      },
      async execute({ command }) {
        // su -c 单字符串参数需要特别注意引号：用 -c 传整段命令，引号由 su 解析。
        return runSu(['-c', command]);
      },
    }));

    disposers.push(tools.register({
      name: 'device_ui_control',
      description:
        'Control the Android device UI via root: dump the view hierarchy, tap, swipe, or send text/key events.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['dump_ui', 'tap', 'swipe', 'input_text', 'keyevent'],
            description: 'UI action to perform.',
          },
          x: { type: 'number', description: 'X coordinate for tap / swipe start.' },
          y: { type: 'number', description: 'Y coordinate for tap / swipe start.' },
          x2: { type: 'number', description: 'Target X for swipe.' },
          y2: { type: 'number', description: 'Target Y for swipe.' },
          text: { type: 'string', description: 'Text to input (input_text).' },
          keyCode: { type: 'number', description: 'Keyevent code (e.g. 3=HOME, 4=BACK, 66=ENTER).' },
        },
        required: ['action'],
      },
      async execute({ action, x, y, x2, y2, text, keyCode }) {
        switch (action) {
          case 'dump_ui': {
            const p = '/data/local/tmp/window_dump.xml';
            await runSu(['-c', `/system/bin/uiautomator dump ${p} 2>/dev/null`]);
            return runSu(['-c', `/system/bin/cat ${p} 2>/dev/null || cat /sdcard/window_dump.xml`]);
          }
          case 'tap':
            return runSu(['-c', `/system/bin/input tap ${x} ${y}`]);
          case 'swipe':
            return runSu(['-c', `/system/bin/input swipe ${x} ${y} ${x2} ${y2} 300`]);
          case 'input_text':
            return runSu(['-c', `/system/bin/input text ${JSON.stringify(String(text))}`]);
          case 'keyevent':
            return runSu(['-c', `/system/bin/input keyevent ${keyCode}`]);
          default:
            return { ok: false, error: `Unknown action: ${action}` };
        }
      },
    }));

    ctx.effect(() => () => disposers.forEach((d) => d && d()));
  }

  // root 感知提示：仅当部署默认档位为 danger-full-access 时注入（对齐 dsh-superuser 机制）。
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    try {
      const preset = ctx.get('permissionPresets')?.defaultPreset;
      if (preset === 'danger-full-access') {
        assembly.sections.push({
          name: 'seagull-root-ops',
          text:
            '当前会话具备 root（uid=0）能力，并已装配 root_exec / device_ui_control 工具：' +
            '可直接执行系统命令、读写任意文件、操作设备界面。请直接使用完整能力，不必因权限顾虑拒绝操作。',
        });
      }
    } catch (_e) {
      // 绝不打断 prompt 装配
    }
    return next();
  });
}