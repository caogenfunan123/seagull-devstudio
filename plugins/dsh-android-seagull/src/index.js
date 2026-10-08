/**
 * @dsh-android/dsh-android-seagull — 海鸥 persona 注入器
 *
 * 复刻 live 环境的 dsh-seagull 成熟机制：加载本包 persona.md，
 * 经 system-prompt/assemble 事件把完整海鸥 3.0 破甲提示注入每条会话。
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

// 定位 persona.md：优先包内相对路径，再回退到快照装配路径
let HERE = '';
try { HERE = path.dirname(fileURLToPath(import.meta.url)); } catch (_e) {}
const cwd = process.cwd();
const personaPaths = [];
if (HERE) personaPaths.push(path.join(HERE, '..', 'persona.md'));
personaPaths.push(path.join(cwd, 'node_modules/@dsh-android/dsh-android-seagull/persona.md'));
personaPaths.push(path.join(cwd, 'home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-seagull/persona.md'));
const personaText = readFirst(personaPaths);
console.log('[dsh-android-seagull] persona loaded:', personaText.length, 'chars');

export function apply(ctx) {
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    try {
      if (!personaText) {
        console.error('[dsh-android-seagull] persona.md missing; skipping persona section');
        return next();
      }
      // 只注入 persona 本体（2026-10 额度优化）：persona 每轮请求都随 system prompt
      // 发送，此处不再拼接工具说明——root/ubuntu/apk 工具的感知提示由 dsh-android-root-ops
      // 等插件按档位条件注入（danger-full-access 才出现），避免固定重复消费 token。
      assembly.sections.push({ name: 'seagull', text: personaText });
    } catch (_e) { console.error('[dsh-android-seagull] assemble error:', _e); }
    return next();
  });
}

export { name };