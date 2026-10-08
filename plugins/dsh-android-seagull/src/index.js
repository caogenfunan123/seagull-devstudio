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
}

export { name };