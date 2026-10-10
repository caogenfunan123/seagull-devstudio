/**
 * @dsh-android/dsh-android-seagull — 海鸥 persona 注入器
 *
 * 复刻 live 环境的 dsh-seagull 成熟机制：加载本包 persona.md，
 * 经 system-prompt/assemble 事件注入每条会话。
 *
 * 2026-10 额度优化（分层注入）：persona 每轮请求都随 system prompt 发送，
 * 全量 16.5K 字符中约 10K 是安全/CTF 技能路由模块——非 danger-full-access
 * 会话用不到。拆出 persona-core.md（身份/行为/风格，6.9K）按档位注入：
 * danger-full-access 注入全量（技术场景行为零变化），其余档位只注 core
 * （省 ~9.7K 字符/轮）。档位读不到或任何异常一律回退全量——绝不让装配降级
 * 成「人格残缺」，try/catch 与存在性检查双兜底。
 *
 * 2026-10 工具面裁剪（额度优化 #1）：新会话工具面实测 89 个（约 14K 字符/轮
 * 固定开销），其中 22 个 root/ADB 通道工具在非 danger-full-access 档位下
 * gateFor 必拒——schema 纯占每轮 token。经 ctx.on('agent/created') 在首轮
 * prompt assembly 前对 agent scope 挂 tools.restrict({ deny })，并监听
 * sandbox/mode / permission/preset 会话事件动态跟随档位切换（切回 danger
 * 即解除，功能零回归）。裁剪与 persona 分层共用同一档位判据（sandboxPolicy
 * resolve + permissionPresets.defaultPreset 兜底，与 bridge gateFor 同源）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const name = 'seagull';

function readFirst(paths) {
  for (const c of paths) {
    try {
      if (existsSync(c)) return readFileSync(c, 'utf8');
    } catch (_e) { /* keep trying */ }
  }
  return '';
}

// 定位 persona 文件：优先包内相对路径，再回退到快照装配路径
let HERE = '';
try { HERE = path.dirname(fileURLToPath(import.meta.url)); } catch (_e) {}
const cwd = process.cwd();
const relPaths = [
  path.join(cwd, 'node_modules/@dsh-android/dsh-android-seagull/'),
  path.join(cwd, 'home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-seagull/'),
];
const fullPaths = [];
const corePaths = [];
if (HERE) {
  fullPaths.push(path.join(HERE, '..', 'persona.md'));
  corePaths.push(path.join(HERE, '..', 'persona-core.md'));
}
for (const base of relPaths) {
  fullPaths.push(path.join(base, 'persona.md'));
  corePaths.push(path.join(base, 'persona-core.md'));
}
const personaText = readFirst(fullPaths);
const personaCoreText = readFirst(corePaths);
console.log('[dsh-android-seagull] persona loaded: full=' + personaText.length + ' chars, core=' + personaCoreText.length + ' chars');

// root/ADB 通道工具名单（非 danger 档位 deny 集）——全部经 gateFor 前置校验，
// 非 danger-full-access 会话中调用必被拒，schema 属纯 token 开销：
// - root-ops 10 个：root 通道（su/KernelSU），root 感知说明也仅 danger 注入；
// - manage 8 个：androidPrivilege ADB 通道（screencap/uiautomator/dumpsys/input）；
// - bridge 2 个 ADB 执行面（android_privilege_status 为只读状态查询，保留不裁）；
// - ubuntu_toolchain_install：root chroot apt（坑 13/38 root 专属路径）；
// - apk_install：root 通道 su -c pm install（apk-tools 其余 6 个走宿主 java 链，保留）。
const DANGER_CHANNEL_TOOLS = [
  'root_exec', 'device_ui_control', 'root_status', 'root_ls', 'root_cat',
  'root_push', 'root_pull', 'root_fetch', 'root_deploy', 'ubuntu_boot_fix',
  'android_act_input', 'android_device_info', 'android_screenshot',
  'android_ui_click', 'android_ui_dump', 'android_ui_input',
  'android_ui_scroll', 'android_ui_tree',
  'android_adb_shell_exec', 'android_termux_channel_exec',
  'ubuntu_toolchain_install', 'apk_install',
];

export function apply(ctx) {
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    try {
      if (!personaText) {
        console.error('[dsh-android-seagull] persona.md missing; skipping persona section');
        return next();
      }
      // 档位判定：与 dsh-android-root-ops 同源（permissionPresets.defaultPreset）。
      // 读不到档位 / core 文件缺失 / 任何异常 → 全量注入（兜底，人格不残缺）。
      let text = personaText;
      try {
        const preset = ctx.get('permissionPresets')?.defaultPreset;
        if (preset && preset !== 'danger-full-access' && personaCoreText) {
          text = personaCoreText;
        }
      } catch (_e) {
        text = personaText;
      }
      assembly.sections.push({ name: 'seagull', text });
    } catch (_e) { console.error('[dsh-android-seagull] assemble error:', _e); }
    return next();
  });

  // ---- 工具面裁剪（档位感知，动态跟随）----
  const restrictedAgents = new Map(); // agent -> restrict disposer

  // 档位判据与 bridge gateFor 同源：sandboxPolicy.resolve({session}) 优先
  // （读会话 sandbox/mode 事件投影，回退部署默认），permissionPresets.defaultPreset 兜底。
  const sessionMode = (agent) => {
    try {
      const policy = ctx.get('sandboxPolicy');
      if (policy && typeof policy.resolve === 'function') {
        const mode = policy.resolve({ session: agent?.session })?.mode;
        if (mode) return mode;
      }
    } catch (_e) { /* fall through */ }
    try {
      return ctx.get('permissionPresets')?.defaultPreset || undefined;
    } catch (_e2) {
      return undefined;
    }
  };

  // 幂等：先解除既有 restriction 再按当前档位重判——档位切换与重复事件都安全。
  // 档位读不到 / tools face 缺失 / 工具名单拿不到 → 不裁剪（fail-open：宁可多给
  // 工具不少给，功能零回归，优化失效而已）；deny 与已注册工具取交集，marketplace
  // 卸载某插件时不会因 unknown name throw。
  const applyToolPolicy = (agent) => {
    try {
      const prev = restrictedAgents.get(agent);
      if (prev) {
        try { prev(); } catch (_e) { /* already disposed */ }
        restrictedAgents.delete(agent);
      }
      if (sessionMode(agent) === 'danger-full-access') return;
      const tools = ctx.get('tools');
      if (!tools || typeof tools.schemas !== 'function' || typeof agent?.ctx?.tools?.restrict !== 'function') return;
      let known;
      try {
        known = new Set(tools.schemas(agent).map((t) => t.name));
      } catch (_e2) {
        return;
      }
      if (known.size === 0) return;
      const deny = DANGER_CHANNEL_TOOLS.filter((n) => known.has(n));
      if (deny.length === 0) return;
      const dispose = agent.ctx.tools.restrict({ deny });
      restrictedAgents.set(agent, dispose);
      console.log('[dsh-android-seagull] tool policy: denied ' + deny.length + '/' + DANGER_CHANNEL_TOOLS.length
        + ' danger-channel tools (agent=' + (agent?.id ?? 'unknown') + ')');
    } catch (_e) {
      console.error('[dsh-android-seagull] tool policy error:', _e);
    }
  };

  // agent/created 在首轮 prompt assembly 之前发出且为 serial await——在此挂
  // restriction 保证首个 LLM 请求的 tools 列表已裁剪。
  ctx.on('agent/created', async ({ agent }) => { applyToolPolicy(agent); });
  ctx.on('agent/disposed', ({ agent }) => {
    const d = restrictedAgents.get(agent);
    if (d) {
      try { d(); } catch (_e) { /* scope unwind already disposed */ }
      restrictedAgents.delete(agent);
    }
  });
  // 档位切换动态跟随：UI 档位选择器写 sandbox/mode，/permission 命令写
  // permission/preset——事件提交后投影已 fold，按新档位 dispose+重判。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || (event.type !== 'sandbox/mode' && event.type !== 'permission/preset')) return;
      for (const agent of (ctx.agents?.list?.() ?? [])) {
        if (agent?.session === session) applyToolPolicy(agent);
      }
    } catch (_e) { /* ignore */ }
  });
  // 热加载兜底：插件装载时已存在的 agent（引擎重启后快照热装配路径）。
  try {
    for (const agent of (ctx.agents?.list?.() ?? [])) applyToolPolicy(agent);
  } catch (_e) { /* ignore */ }
}

export { name };