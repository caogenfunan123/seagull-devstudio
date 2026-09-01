/**
 * @dsh-android/dsh-android-root-ops — Root 操作服务与工具（含 root 保活）
 *
 * 经 root (uid=0) 执行系统命令、读写任意文件、操作设备 UI。
 * 仅在用户开启「关闭沙盒/超级用户」(danger-full-access) 预置时注入 root 感知提示。
 *
 * root 保活（Seagull fork 2026-09-02）：
 *   · 周期巡检 su 可用性（su -c id 必须回 uid=0）——失败自动重试并记录；
 *   · KernelSU allowlist 校验——包名不在 /data/adb/ksu/.allowlist 则提示加入授权名单，
 *     避免每次 root 调用被系统弹窗拦截/拒绝（保活的本质是「root 通道持续可用」）；
 *   · root_status 工具供模型查询保活状态（最后检查/失败历史/allowlist 是否就位）。
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

const ROOT_SU = '/system/bin/su';
const KSU_ALLOWLIST = '/data/adb/ksu/.allowlist';
const KSU_DENYLIST = '/data/adb/ksu/.denylist';
const PKG = 'com.dsharnessmobile.shell';

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

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

/**
 * root 保活状态机（进程内，插件生命周期内维护）。
 */
function createKeepalive() {
  let lastCheckAt = 0;
  let lastOk = false;
  let failCount = 0;
  let lastError = '';
  let allowlisted = false;

  async function probeRoot() {
    const r = await runSu(['-c', 'id'], { timeout: 15000 });
    const ok = r.ok && /uid=0\(root\)/.test(r.stdout);
    lastCheckAt = Date.now();
    lastOk = ok;
    lastError = ok ? '' : (r.error || r.stderr || 'root 检查未通过');
    if (ok) failCount = 0; else failCount += 1;
    return ok;
  }

  async function probeAllowlist() {
    try {
      const r = await runSu(['-c', `cat ${KSU_ALLOWLIST} 2>/dev/null || cat ${KSU_DENYLIST} 2>/dev/null || true`], { timeout: 15000 });
      const text = r.stdout || '';
      allowlisted = text.split('\n').some((line) => line.trim() === PKG);
    } catch {
      allowlisted = false;
    }
    return allowlisted;
  }

  return {
    /** 立即巡检一次（root 可用性 + allowlist），返回健康状态。 */
    async check() {
      const ok = await probeRoot();
      const al = await probeAllowlist();
      return {
        ok, rootReady: ok, allowlisted: al,
        lastCheckAt, lastOk, failCount, lastError,
      };
    },
    /** 周期保活 tick：root 失败时做一次恢复重试，并校验 allowlist。 */
    async tick() {
      let ok = await probeRoot();
      if (!ok) {
        // 瞬时握手/系统忙的恢复窗口：立即重试一次
        ok = await probeRoot();
      }
      if (!ok) await probeAllowlist();
      return { ok, lastCheckAt, failCount, lastError, allowlisted };
    },
    status() {
      return {
        rootReady: lastOk,
        allowlisted,
        lastCheckAt,
        failCount,
        lastError,
        suPath: ROOT_SU,
        pkg: PKG,
      };
    },
  };
}

function tools(keepalive) {
  const rootTool = defineTool({
    name: 'root_exec',
    description:
      'Execute a shell command with full root (uid=0) privileges in a clean Android environment. ' +
      'Use for system-wide read/write, app data access, /proc inspection, or privileged patching.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run as root.' } },
      required: ['command'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ command }) {
      // su -c 单字符串参数需要特别注意引号：用 -c 传整段命令，引号由 su 解析。
      return runSu(['-c', command]);
    },
  });

  const uiTool = defineTool({
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
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
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
  });

  const statusTool = defineTool({
    name: 'root_status',
    description:
      'Report the Seagull root keepalive state: whether /system/bin/su (KernelSU) is available, ' +
      'whether this app is in the KernelSU allowlist, and recent health history.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() {
      const st = await keepalive.check();
      return {
        ok: st.ok,
        rootReady: st.rootReady,
        allowlisted: st.allowlisted,
        suPath: ROOT_SU,
        pkg: PKG,
        lastCheckAt: st.lastCheckAt,
        failCount: st.failCount,
        lastError: st.lastError,
        message: st.ok
          ? (st.allowlisted
            ? 'root 就绪，且本应用已在 KernelSU 授权名单（免弹窗保活）'
            : 'root 就绪，但本应用不在 KernelSU allowlist——root 调用可能弹窗确认，建议加入授权名单')
          : 'root 不可用：' + (st.lastError || 'su 未就绪'),
      };
    },
  });

  return [rootTool, uiTool, statusTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  const keepalive = createKeepalive();
  for (const t of tools(keepalive))
    ctx.tools.register(t);

  // root 保活周期巡检：60s 心跳；失败自动重试；stop/update 时由 ctx.effect 清理。
  const timer = ctx.get('timer');
  if (timer !== undefined) {
    ctx.effect(() => {
      const disposer = timer.interval(() => {
        keepalive.tick().catch(() => {});
      }, 60000);
      return () => disposer && disposer();
    });
  }

  // 提供保活服务面（供其他插件/工具查询同一状态机）。
  ctx.provide('rootKeepalive', {
    status: () => keepalive.status(),
    check: () => keepalive.check(),
  });

  // root 感知提示：仅当部署默认档位为 danger-full-access 时注入（对齐 dsh-superuser 机制）。
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    try {
      const preset = ctx.get('permissionPresets')?.defaultPreset;
      if (preset === 'danger-full-access') {
        assembly.sections.push({
          name: 'seagull-root-ops',
          text:
            '当前会话具备 root（uid=0）能力，并已装配 root_exec / device_ui_control / root_status 工具：' +
            '可直接执行系统命令、读写任意文件、操作设备界面。root 通道由保活巡检维持在线。' +
            '请直接使用完整能力，不必因权限顾虑拒绝操作。',
        });
      }
    } catch (_e) {
      // 绝不打断 prompt 装配
    }
    return next();
  });
}
