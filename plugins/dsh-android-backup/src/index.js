/**
 * @dsh-android/dsh-android-backup - 会话与配置备份/恢复（0.13.3 P2，UPGRADE-PLAN.md §3-P2）
 *
 * 对齐 DSHA BackupScope 四档语义（FULL/SESSIONS/SETTINGS/PLUGINS）：
 *   full     = sessions + settings.yaml + storages + profiles/web 配置层（不含 node_modules 大树）
 *   sessions = 仅 sessions/（对话历史）
 *   settings = 仅 settings.yaml + .credentials.yaml（凭据含在内——本机口令加密场景，用户自担）
 *   plugins  = 仅 profiles/web/{package.json,cordis.patch.yml,cordis.yml}（插件装配清单）
 *
 * 归档 tar.gz 落 dshdata/exports/（公共导出仓库，SAF 可见）；文件名带档位前缀
 * （DSHA 踩坑：老版本把「只对话」包当全量恢复——档位显式进文件名杜绝误判）。
 * 恢复前强制 undo-savepoint 快照（失败可退）；恢复只覆盖档位内文件，绝不整树替换。
 *
 * 执行面：引擎进程内 spawn tar（GNU tar 1.35 随快照），不引第三方 npm 依赖。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

export const name = 'dsh-android-dsh-backup';
export const inject = ['tools'];

const SCOPES = ['full', 'sessions', 'settings', 'plugins'];

function dshRoot() {
  return process.env.DSH_HOME || '/data/data/com.dsharnessmobile.shell/files/home/.dsh';
}

/**
 * tar/gzip 执行环境：GNU tar 的 -z 靠 PATH 找 gzip——引擎子进程继承的 PATH
 * 不保证含 $PREFIX/bin（实测 gzip: Cannot exec）。显式补全。
 */
function execEnv() {
  const usr = process.env.TERMUX__PREFIX || process.env.PREFIX || '/data/data/com.dsharnessmobile.shell/files/usr';
  return { ...process.env, PATH: `${usr}/bin:${process.env.PATH || '/system/bin'}` };
}

/** 导出仓库：dshdata/exports（公共面）；不可用退 .dsh/exports */
function exportDir() {
  const home = join(dshRoot(), '..');
  const pub = join(home, 'dshdata', 'exports');
  try {
    mkdirSync(pub, { recursive: true });
    // 探写：公共存储可能只读/不存在
    const probe = join(pub, '.probe');
    writeFileSync(probe, 'x');
    rmSync(probe);
    return pub;
  } catch { /* 公共面不可写 → 应用域回退 */ }
  const fallback = join(dshRoot(), 'exports');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** 档位 → tar -T 清单（相对 $DSH_HOME 的路径；逐条 exists 过滤） */
function scopePaths(scope) {
  const root = dshRoot();
  const pick = (...rels) => rels.filter((r) => existsSync(join(root, r)));
  switch (scope) {
    case 'sessions': return pick('sessions');
    case 'settings': return pick('settings.yaml', '.credentials.yaml', '.private-layout');
    case 'plugins': return pick('profiles/web/package.json', 'profiles/web/pnpm-workspace.yaml', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml');
    case 'full':
    default: return [
      ...pick('sessions', 'storages', 'attachments', 'settings.yaml', '.credentials.yaml', '.private-layout'),
      ...pick('profiles/web/package.json', 'profiles/web/pnpm-workspace.yaml', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml'),
    ];
  }
}

/**
 * tar 裸归档 + gzip 独立压缩两步走（实测快照内 tar.real -z 的 gzip 子进程 exec 必挂：
 * 'gzip: Cannot exec'，与 LD_PRELOAD/PATH 无关；裸 tar 与独立 gzip 均正常）。
 * -T 清单避免命令行长度与注入问题。
 */
async function tarCreate(scope, outPath) {
  const root = dshRoot();
  const paths = scopePaths(scope);
  if (!paths.length) throw new Error('档位内容为空，无可备份项');
  const listFile = join(root, 'tmp', `backup-${scope}-${Date.now()}.list`);
  mkdirSync(join(root, 'tmp'), { recursive: true });
  writeFileSync(listFile, paths.join('\n'));
  try {
    const plainTar = outPath.replace(/\.tar\.gz$/, '.tar');
    try {
      await execFileAsync('tar', ['-C', root, '-cf', plainTar, '-T', listFile, '--ignore-failed-read'], { env: execEnv(), timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      await execFileAsync('gzip', ['-f', plainTar], { env: execEnv(), timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      // gzip -f 产出 plainTar.gz；归一化到期望的 .tar.gz 名
      if (plainTar + '.gz' !== outPath) renameSync(plainTar + '.gz', outPath);
    } catch (err) {
      try { rmSync(plainTar, { force: true }); } catch { /* 清理失败忽略 */ }
      throw err;
    }
  } finally {
    try { rmSync(listFile); } catch { /* 清理失败无所谓 */ }
  }
  return paths;
}

/** 恢复：node zlib 解压 → 裸 tar 解包（先 -t 自检 + zip-slip 防护，再 -x 落地） */
async function tarRestore(archivePath) {
  const root = dshRoot();
  const plainTar = join(dirname(archivePath), basename(archivePath).replace(/\.tar\.gz$/, '.tar'));
  try { rmSync(plainTar, { force: true }); } catch { /* 残留清理 */ }
  // gzip 解压走 node:zlib（引擎进程内零外部依赖；tar.real -z 与独立 gzip 管道均绕开）
  const { gunzipSync } = await import('node:zlib');
  const raw = gunzipSync(readFileSync(archivePath));
  writeFileSync(plainTar, raw);
  const { stdout } = await execFileAsync('tar', ['-tf', plainTar], { env: execEnv(), timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  const members = stdout.trim().split('\n').filter(Boolean);
  if (!members.length) throw new Error('归档为空或损坏');
  // 危险条目防护：绝对路径/.. 逃逸拒绝（zip-slip 同源，AGENTS.md SnapshotExtractor 先例）
  for (const m of members) {
    if (m.startsWith('/') || m.split('/').includes('..')) {
      throw new Error(`归档含越界条目，拒绝恢复: ${m}`);
    }
  }
  await execFileAsync('tar', ['-C', root, '-xf', plainTar], { env: execEnv(), timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
  try { rmSync(plainTar, { force: true }); } catch { /* 清理失败忽略 */ }
  return members.length;
}

/** 恢复前强制快照（调 dsh-undo-savepoint 的工具语义太重，这里做轻量文件级快照） */
function preRestoreSnapshot(archivePath) {
  const root = dshRoot();
  const dir = join(root, 'undo-snapshots', 'pre-backup-restore');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copied = [];
  for (const rel of scopePaths('full')) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dst = join(dir, stamp, rel);
    try {
      mkdirSync(dst.slice(0, dst.lastIndexOf('/')), { recursive: true });
      if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true });
      else cpSync(src, dst);
      copied.push(rel);
    } catch { /* 单项失败不阻断（恢复仍可退到 tar 本身） */ }
  }
  // stamp 目录兜底（2026-10 复盘修复）：scope 全部 skip/失败时循环不会建出
  // dir/stamp 层，writeFileSync 直接 ENOENT 把恢复流程抛死。
  mkdirSync(join(dir, stamp), { recursive: true });
  writeFileSync(join(dir, stamp, '_restored-from.json'), JSON.stringify({ archive: basename(archivePath), ts: new Date().toISOString(), copied }));
  return { dir: join(dir, stamp), copied: copied.length };
}

function listArchives() {
  const dir = exportDir();
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.tar.gz'))
      .map((n) => {
        const st = statSync(join(dir, n));
        return { name: n, bytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { return []; }
}

function buildService() {
  return {
    async backup(scope, label) {
      if (!SCOPES.includes(scope)) return { ok: false, error: `未知档位 ${scope}（full|sessions|settings|plugins）` };
      const dir = exportDir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      // label 净化：只保留文件名安全字符（防路径注入），空 label 行为不变
      const tag = (label || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      const out = join(dir, `seagull-${scope}-${tag ? tag + '-' : ''}${stamp}.tar.gz`);
      try {
        const paths = await tarCreate(scope, out);
        const bytes = statSync(out).size;
        return { ok: true, scope, archive: out, bytes, entries: paths.length };
      } catch (err) {
        try { rmSync(out, { force: true }); } catch { /* 清理失败忽略 */ }
        return { ok: false, error: err.message };
      }
    },
    async restore(archiveName) {
      const dir = exportDir();
      // 只允许导出仓库内的文件名（防路径注入；不含分隔符）
      if (archiveName.includes('/') || archiveName.includes('..')) return { ok: false, error: '非法归档名' };
      const archivePath = join(dir, archiveName);
      if (!existsSync(archivePath)) return { ok: false, error: `归档不存在: ${archiveName}（disk: ${dir}）` };
      if (!archiveName.endsWith('.tar.gz')) return { ok: false, error: '仅支持 .tar.gz 归档' };
      try {
        const snap = preRestoreSnapshot(archivePath);
        const members = await tarRestore(archivePath);
        return { ok: true, restored: archiveName, members, preRestoreSnapshot: snap.dir, note: '已恢复；插件清单变更需重启引擎生效' };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    list() { return { dir: exportDir(), archives: listArchives() }; },
  };
}

function renderText(_args, v) {
  return [{ type: 'text', text: JSON.stringify(v, null, 2).slice(0, 3000) }];
}

function tools(service) {
  const backupTool = defineTool({
    name: 'backup_create',
    description:
      '创建备份归档（tar.gz，落 dshdata/exports/）。档位：full=会话+设置+存储+插件清单 / sessions=仅对话 / settings=仅配置凭据 / plugins=仅插件装配清单。文件名带档位前缀防误恢复。',
    parameters: {
      scope: { type: 'string', required: true, description: '备份档位：full | sessions | settings | plugins', enum: SCOPES },
      label: { type: 'string', description: '可选备注名（仅保留字母数字_-，最长 32 字符；进文件名便于识别，如 test1）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ scope, label }) { return service.backup(scope, label); },
  });

  const restoreTool = defineTool({
    name: 'backup_restore',
    description:
      '从导出仓库的归档恢复（先自动做恢复前快照，失败可退）。只覆盖归档内文件，绝不整树替换；插件清单变更需重启引擎。',
    parameters: {
      archive: { type: 'string', required: true, description: '归档文件名（backup_list 查得的 name，不含路径）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ archive }) { return service.restore(archive); },
  });

  const listTool = defineTool({
    name: 'backup_list',
    description: '列出导出仓库内全部备份归档（名称/大小/时间）与仓库路径。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...service.list() }; },
  });

  return [backupTool, restoreTool, listTool];
}

export function apply(ctx) {
  const service = buildService();
  ctx.provide('dshBackup', service);
  for (const t of tools(service)) ctx.tools.register(t);
}
