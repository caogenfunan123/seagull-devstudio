/**
 * @dsh-android/dsh-android-dev-tools — Ubuntu PRoot 容器命令执行
 *
 * 通过 proot-entry.sh 进入 Ubuntu 24.04 ARM64 容器执行构建/开发命令。
 *
 * C 方案修复 (2026-09-01)：对齐 dsh-android-bridge 成功模式——
 *   inject 声明 tools 硬依赖 + defineTool 包装工具，修复 ctx.get('tools') 静默 undefined。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

function ubuntuEntry() {
  const home = process.env.HOME || '/data/data/com.dsharnessmobile.shell/files/home';
  return `${home}/.dsh/ubuntu-rootfs/proot-entry.sh`;
}

function renderText(_a, v) {
  return [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }];
}

/** 单引号包裹防命令注入（对齐 root-ops/apk-tools 的 shellQuote 语义）。 */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** apt 输出可能很长，只保留尾部（错误摘要通常在末尾），封顶 8KB。 */
function tailOut(s) {
  const t = (s || '').trim();
  return t.length > 8192 ? t.slice(-8192) : t;
}

function tools() {
  const execTool = defineTool({
    name: 'ubuntu_exec',
    description:
      'Execute a build or development command inside the Seagull Ubuntu container ' +
      '(apt/dpkg/gcc/cmake/python3/java toolchain). Typically used for APK reverse/build, ' +
      'C/C++ compilation, or Python tooling that needs a full distro.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run inside Ubuntu (bash -lc).' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ command, timeoutMs = 120000 }) {
      const entry = ubuntuEntry();
      // proot-entry.sh 是 bash 脚本（依赖 ${BASH_SOURCE[0]}，shebang #!/bin/bash），必须用 bash 执行；
      // 用 PATH 查找的 `bash`（termux $PREFIX/bin/bash），不硬编码 /bin/bash 依赖 LD_PRELOAD 重路由。
      const shell = 'bash';
      try {
        const { stdout, stderr } = await execFileAsync(shell, [entry, '-lc', command], {
          timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
      } catch (err) {
        return { ok: false, error: err.message, stderr: err.stderr ? String(err.stderr).trim() : '' };
      }
    },
  });

  const statusTool = defineTool({
    name: 'ubuntu_status',
    description: 'Report whether the Ubuntu rootfs is present and its size.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute() {
      const { access, stat } = await import('node:fs/promises');
      const entry = ubuntuEntry();
      const rootfs = entry.replace('/proot-entry.sh', '');
      // marker = Ubuntu 关键二进制 usr/bin/bash（Ubuntu 24.04 的 bin -> usr/bin 软链），
      // 与壳侧 extractToolAssets 幂等落点（bin/bash）对齐。仅 access 根目录会漏判
      // 「目录在但内容未解压」以及软链丢失的残缺装配。
      const bash = `${rootfs}/usr/bin/bash`;
      let st;
      try {
        await access(bash);
        // 2026-10 复盘修复：stat 原在 try 外——access 与 stat 之间软链断裂/竞态会抛
        // 未捕获异常把整个工具执行崩掉。合并进同一 try，如实转为 not-present 语义。
        st = await stat(bash);
      } catch {
        return { ok: false, present: false, rootfs, message: 'Ubuntu rootfs 未装配（缺 usr/bin/bash）：请确认 APK 内置 rootfs 资产已完整解压到 .dsh/ubuntu-rootfs。' };
      }
      return { ok: true, present: true, rootfs, bashBytes: st.size };
    },
  });

  const toolchainTool = defineTool({
    name: 'ubuntu_toolchain_install',
    description:
      'Install the compile toolchain (build-essential/gcc/g++/make/cmake/git/python3) inside the ' +
      'Seagull Ubuntu container via apt. The APK now ships a slim minbase rootfs (no toolchain baked ' +
      'in) to keep it light-asset; call this once after ubuntu_status confirms the rootfs is present. ' +
      'Requires root chroot (KernelSU) for a reliable apt/dpkg run — without root, dpkg hits the ' +
      'SYSCONFDIR sandbox limitation (坑13) and the install may partially fail; the tool reports this honestly.',
    parameters: {
      packages: { type: 'string', description: 'Optional space-separated extra apt packages to install. Defaults to "build-essential cmake git python3".' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 900000).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
    async execute({ packages, timeoutMs = 900000 }) {
      const entry = ubuntuEntry();
      // 白名单字符闸（apt 包名字符集：字母数字 + . + _ + -），非法项丢弃；再逐个单引号包裹——双保险防注入。
      const extra = String(packages || '').trim().split(/\s+/).filter((p) => /^[A-Za-z0-9._+-]+$/.test(p)).map((p) => shQuote(p)).join(' ')
        || 'build-essential cmake git python3';
      const pkgs = extra;
      // 探测 root 通道：/system/bin/su 可执行 = proot-entry.sh 会走 root chroot（apt 可靠）；
      // 否则纯 proot，dpkg 触发 SYSCONFDIR 限制（坑13），如实降级报告。
      let hasRoot = false;
      try {
        const { accessSync, constants } = await import('node:fs');
        accessSync('/system/bin/su', constants.X_OK);
        hasRoot = true;
      } catch { hasRoot = false; }
      const script =
        'set -e; export DEBIAN_FRONTEND=noninteractive; ' +
        '[ -s /etc/apt/sources.list ] || printf "deb http://ports.ubuntu.com/ubuntu-ports noble main universe\\n" > /etc/apt/sources.list; ' +
        'apt-get update -y && apt-get install -y --no-install-recommends ' + pkgs + ' && apt-get clean';
      if (!hasRoot) {
        return {
          ok: false, rootRequired: true,
          error: '未检测到 root 通道（/system/bin/su 不可执行）：纯 proot 下 apt/dpkg 会触发 SYSCONFDIR 沙箱限制（坑13），无法可靠安装工具链。请在已 root 的设备上重试，或改用宿主 Termux 的按需安装器。',
        };
      }
      try {
        const { stdout, stderr } = await execFileAsync('bash', [entry, '-lc', script], {
          timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, root: true, packages: pkgs.trim(), stdout: tailOut(stdout), stderr: (stderr || '').trim() };
      } catch (err) {
        return { ok: false, root: true, error: err.message, stderr: tailOut(err.stderr ? String(err.stderr) : '') };
      }
    },
  });

  return [execTool, statusTool, toolchainTool];
}

// C 方案：显式声明 tools 硬依赖（对齐 bridge/manage），修复 ctx.get('tools') 静默 undefined。
export const inject = ['tools'];

export function apply(ctx) {
  for (const t of tools())
    ctx.tools.register(t);
}
