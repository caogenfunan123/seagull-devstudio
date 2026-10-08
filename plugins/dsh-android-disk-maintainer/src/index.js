/**
 * @dsh-android/dsh-android-disk-maintainer - 磁盘维护（0.13.3 P1，UPGRADE-PLAN.md §3-P1）
 *
 * 用户诉求「用久了塞太多东西会卡死」实测根因（docs/UPGRADE-PLAN.md §1.2）：
 * session 仅 9.4MB 不是问题源；真热点是 workspaces（747MB，用户项目）与
 * fetched/（46MB，root_fetch 下载件，无 TTL）。本插件只清「可再生/临时」面，
 * 绝不碰用户工作区；workspaces 只出体积报告供用户自行处置。
 *
 * 策略（全部可配，默认保守）：
 *   fetched/      > 14 天 或 总量 > 200MB → 删最旧（root_fetch 产物，可重新拉取）
 *   tmp/          > 3 天                  → 清空
 *   sessions/     > 90 天                 → 删（保留最近 200 个）
 *   .node-compile-cache/ > 500MB          → 清（V8 缓存可重建）
 *   workspaces/   只报告 TOP20 体积，绝不删除
 *
 * 触发：挂载后延迟 60s 跑一次（避开引擎启动高峰），此后每 6h 一次；
 * 定时器经 ctx.effect 持有，插件卸载即清理。维护日志写 .dsh/log/maintain.log。
 */
import { readdirSync, lstatSync, existsSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-android-disk-maintainer';
export const inject = ['tools'];

/**
 * 单文件/目录递归字节数（有界版，2026-10-08 真机虚报 322GB 实锤修复）：
 * - lstat 语义：软链只算链接本身，防目录环重复计数；
 * - **挂载边界**：记录递归根 st_dev，跨设备（proc/sys/dev 挂载、bind）不计入——
 *   rootfs 运行时挂着真 proc，无边界递归会把 /proc/<pid>/fd 下指向同一批大文件的
 *   幽灵条目累加成虚报体积（实测 322GB vs 实际 285M）；
 * - **显式排除虚拟文件系统目录名**（proc/sys/dev）：容器未运行时空目录不计，
 *   运行中挂载点由 st_dev 边界兜底，双保险。
 */
function sizeOf(p, rootDev) {
  let st;
  try { st = lstatSync(p); } catch { return 0; }
  if (rootDev === undefined) rootDev = st.dev;
  if (st.dev !== rootDev) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    for (const e of readdirSync(p)) {
      if (e === 'proc' || e === 'sys' || e === 'dev') continue;
      total += sizeOf(join(p, e), rootDev);
    }
  } catch { /* 不可读子树按 0 计 */ }
  return total;
}

/** 目录体积与文件数（浅层聚合，供报告） */
function dirStats(p) {
  if (!existsSync(p)) return { bytes: 0, entries: [] };
  const entries = [];
  let bytes = 0;
  for (const e of readdirSync(p)) {
    const full = join(p, e);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isDirectory()) {
      const b = sizeOf(full);
      bytes += b;
      entries.push({ name: e, bytes: b });
    } else {
      bytes += st.size;
      entries.push({ name: e, bytes: st.size });
    }
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { bytes, entries };
}

/** 递归删除（目录/文件/软链通吃；rmSync 对软链安全） */
function remove(p) {
  try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

function dshRoot() {
  return process.env.DSH_HOME || '/data/data/com.dsharnessmobile.shell/files/home/.dsh';
}

function logDir() {
  const d = join(dshRoot(), 'log');
  try { mkdirSync(d, { recursive: true }); } catch { /* 已在 */ }
  return d;
}

function log(action) {
  try {
    appendFileSync(join(logDir(), 'maintain.log'), JSON.stringify({ ts: new Date().toISOString(), ...action }) + '\n');
  } catch { /* 日志失败不阻断维护 */ }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 默认策略（UPGRADE-PLAN.md §3-P1 表格） */
const DEFAULT_POLICY = {
  fetchedMaxAgeDays: 14,
  fetchedMaxBytes: 200 * 1024 * 1024,
  tmpMaxAgeDays: 3,
  sessionMaxAgeDays: 90,
  sessionKeep: 200,
  compileCacheMaxBytes: 500 * 1024 * 1024,
};

/**
 * 清理执行器：dryRun=true 时只算不删（AI/用户先看会删什么）。
 * 返回逐项动作明细 + 汇总；workspaces 永远只在 report 出现。
 */
function runMaintenance(policy, dryRun) {
  const root = dshRoot();
  const actions = [];
  const now = Date.now();

  // 1) fetched/：TTL 或总配额超限 → 删最旧（root_fetch 下载件，可再生）
  const fetchedDir = join(root, 'fetched');
  if (existsSync(fetchedDir)) {
    let files = [];
    try {
      files = readdirSync(fetchedDir).map((n) => {
        const full = join(fetchedDir, n);
        const st = lstatSync(full);
        return { path: full, mtime: st.mtimeMs, size: st.size };
      });
    } catch { /* 不可读跳过 */ }
    const quotaHit = files.reduce((s, f) => s + f.size, 0) > policy.fetchedMaxBytes;
    const victims = files.filter((f) => {
      if (quotaHit) return true;
      return now - f.mtime > policy.fetchedMaxAgeDays * DAY_MS;
    });
    // 只删最旧的一半直到配额内（quotaHit 时保守删一半，避免全清）
    victims.sort((a, b) => a.mtime - b.mtime);
    const cut = quotaHit ? Math.max(1, Math.ceil(files.length / 2)) : victims.length;
    for (const v of victims.slice(0, cut)) {
      const freed = v.size;
      if (!dryRun) remove(v.path);
      actions.push({ target: basename(v.path), kind: 'fetched', freed, removed: !dryRun });
    }
  }

  // 2) tmp/：超龄清空（临时文件）
  const tmpDir = join(root, 'tmp');
  if (existsSync(tmpDir)) {
    let victims = [];
    try {
      victims = readdirSync(tmpDir)
        .map((n) => join(tmpDir, n))
        .filter((p) => { try { return now - lstatSync(p).mtimeMs > policy.tmpMaxAgeDays * DAY_MS; } catch { return false; } });
    } catch { /* 不可读跳过 */ }
    let freed = 0;
    for (const v of victims) {
      freed += sizeOf(v);
      if (!dryRun) remove(v);
    }
    if (victims.length) actions.push({ target: `tmp/ (${victims.length} 项)`, kind: 'tmp', freed, removed: !dryRun });
  }

  // 3) sessions/：超龄删除，保留最近 N 个（按 mtime 排序）
  const sessionsDir = join(root, 'sessions');
  if (existsSync(sessionsDir)) {
    let dirs = [];
    try {
      dirs = readdirSync(sessionsDir)
        .map((n) => join(sessionsDir, n))
        .filter((p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } })
        .map((p) => ({ path: p, mtime: lstatSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch { /* 不可读跳过 */ }
    const keep = dirs.slice(0, policy.sessionKeep);
    const victims = dirs.slice(policy.sessionKeep).filter((d) => now - d.mtime > policy.sessionMaxAgeDays * DAY_MS);
    let freed = 0;
    for (const v of victims) {
      freed += sizeOf(v.path);
      if (!dryRun) remove(v.path);
    }
    if (victims.length) actions.push({ target: `sessions/ (${victims.length} 个超龄会话)`, kind: 'sessions', freed, removed: !dryRun });
    void keep; // keep 仅参与 victims 推导
  }

  // 4) .node-compile-cache/：超配额清空（V8 可重建缓存）
  const cacheDir = join(root, '.node-compile-cache');
  if (existsSync(cacheDir)) {
    const bytes = sizeOf(cacheDir);
    if (bytes > policy.compileCacheMaxBytes) {
      if (!dryRun) remove(cacheDir);
      actions.push({ target: '.node-compile-cache/', kind: 'compile-cache', freed: bytes, removed: !dryRun });
    }
  }

  // 5) workspaces/：只报告，绝不删（用户数据）
  const wsDir = join(root, 'workspaces');
  const ws = dirStats(wsDir);

  const totalFreed = actions.reduce((s, a) => s + a.freed, 0);
  return {
    dryRun,
    policy,
    actions,
    totalFreed,
    workspaces: {
      bytes: ws.bytes,
      top: ws.entries.slice(0, 20),
      note: '用户工作区不自动清理；请自行处置大目录（删除前建议备份）',
    },
  };
}

function buildService() {
  let lastReport = null;
  return {
    /** 当前体积概览（不触发清理） */
    overview() {
      const root = dshRoot();
      const pick = (rel) => { const p = join(root, rel); return existsSync(p) ? sizeOf(p) : 0; };
      return {
        root,
        fetched: pick('fetched'),
        tmp: pick('tmp'),
        sessions: pick('sessions'),
        workspaces: pick('workspaces'),
        compileCache: pick('.node-compile-cache'),
        profiles: pick('profiles'),
        ubuntuRootfs: pick('ubuntu-rootfs'),
      };
    },
    /** dryRun 预览 */
    plan() { return runMaintenance(DEFAULT_POLICY, true); },
    /** 实际执行并返回报告 */
    run() {
      const report = runMaintenance(DEFAULT_POLICY, false);
      lastReport = report;
      log({ kind: 'maintenance', actions: report.actions.length, freed: report.totalFreed });
      return report;
    },
    last() { return lastReport; },
  };
}

function tools(service) {
  const planTool = defineTool({
    name: 'disk_plan',
    description: '预览磁盘维护将执行的动作（dryRun）：会清理什么、释放多少、workspaces 体积 TOP20。执行 disk_maintain 前先看这个。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...service.plan() }; },
  });

  const maintainTool = defineTool({
    name: 'disk_maintain',
    description:
      '执行磁盘维护：清理超龄 fetched/ 下载件、tmp/ 临时文件、超龄 sessions/（保留最近 200 个）、超配额 .node-compile-cache。' +
      '绝不触碰 workspaces/（用户数据）。挂载后每 6h 自动跑一次；此工具用于手动立即执行。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...(await Promise.resolve(service.run())) }; },
  });

  const overviewTool = defineTool({
    name: 'disk_overview',
    description: '磁盘占用概览：.dsh 各子目录字节数（fetched/tmp/sessions/workspaces/compile-cache/profiles/rootfs）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() { return { ok: true, ...service.overview() }; },
  });

  return [overviewTool, planTool, maintainTool];
}

function renderText(_args, v) {
  return [{ type: 'text', text: JSON.stringify(v, null, 2).slice(0, 4000) }];
}

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

export function apply(ctx) {
  const service = buildService();
  ctx.provide('diskMaintainer', service);
  for (const t of tools(service)) ctx.tools.register(t);

  // 定时维护：先延迟首跑，后按 6h 周期。ctx.effect 持有 disposer，插件卸载即清。
  let timer = null;
  let interval = null;
  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (interval) { clearInterval(interval); interval = null; }
  };
  timer = setTimeout(() => {
    try { service.run(); } catch { /* 维护失败不阻断 */ }
    interval = setInterval(() => {
      try { service.run(); } catch { /* 维护失败不阻断 */ }
    }, MAINTENANCE_INTERVAL_MS);
    if (typeof interval.unref === 'function') interval.unref();
  }, FIRST_RUN_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(stop);
}
