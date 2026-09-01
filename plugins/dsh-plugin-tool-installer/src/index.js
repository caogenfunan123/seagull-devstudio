import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import https from 'node:https';

const execAsync = promisify(exec);

const TOOL_REGISTRY = {
  apktool: {
    tier: 'L1',
    type: 'java-jar',
    source: 'https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar',
    installPath: '/data/data/com.seagull.devstudio/files/usr/share/apktool/apktool.jar',
    size: '20MB',
    install: 'auto',
    description: 'APK reverse engineering and rebuild tool'
  },
  jadx: {
    tier: 'L1',
    type: 'archive-zip',
    source: 'https://github.com/skylot/jadx/releases/download/v1.5.0/jadx-1.5.0.zip',
    installPath: '/data/data/com.seagull.devstudio/files/usr/share/jadx/',
    size: '30MB',
    install: 'auto',
    description: 'Dex to Java decompiler'
  },
  radare2: {
    tier: 'L2',
    type: 'archive-tar',
    source: 'https://github.com/radareorg/radare2/releases/download/5.9.8/radare2-5.9.8.tar.xz',
    installPath: '/data/data/com.seagull.devstudio/files/usr/share/radare2/',
    size: '120MB',
    install: 'user-opt-in',
    description: 'Reverse engineering framework (CLI)'
  },
  rizin: {
    tier: 'L2',
    type: 'archive-tar',
    source: 'https://github.com/rizinorg/rizin/releases/download/v0.7.4/rizin-v0.7.4.tar.xz',
    installPath: '/data/data/com.seagull.devstudio/files/usr/share/rizin/',
    size: '90MB',
    install: 'user-opt-in',
    description: 'Modern reverse engineering framework'
  }
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Seagull-DevStudio/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

export function apply(ctx) {
  const toolInstallerService = {
    list() {
      return Object.entries(TOOL_REGISTRY).map(([name, info]) => ({
        name,
        ...info,
        installed: existsSync(info.installPath)
      }));
    },

    async install(name) {
      const info = TOOL_REGISTRY[name];
      if (!info) return { ok: false, error: `Unknown tool: ${name}` };

      if (existsSync(info.installPath)) {
        return { ok: true, alreadyInstalled: true, path: info.installPath };
      }

      try {
        await downloadFile(info.source, `${info.installPath}.download`);
        const proot = `${process.env.HOME}/.dsh/ubuntu-rootfs/proot-entry.sh`;
        await execAsync(`/bin/bash ${proot} -c "mv ${info.installPath}.download ${info.installPath} && chmod +x ${info.installPath}/*"`, {
          timeout: 300000
        });
        return { ok: true, installed: true, path: info.installPath };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async ensure(name) {
      const info = TOOL_REGISTRY[name];
      if (!info) return { ok: false, error: `Unknown tool: ${name}` };
      if (existsSync(info.installPath)) return { ok: true, alreadyInstalled: true };
      if (info.install === 'user-opt-in' || info.install === 'auto') {
        return await this.install(name);
      }
      return { ok: false, error: `Tool ${name} requires explicit user opt-in` };
    },

    info(name) {
      const info = TOOL_REGISTRY[name];
      if (!info) return null;
      return { name, ...info, installed: existsSync(info.installPath) };
    }
  };

  ctx.provide('toolInstaller', toolInstallerService);

  ctx.tools?.register({
    name: 'tool_install',
    description: 'Install a development tool from the three-tier registry',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to install (e.g., apktool, jadx, radare2)' }
      },
      required: ['name']
    },
    async execute({ name }) {
      return await toolInstallerService.install(name);
    }
  });

  ctx.tools?.register({
    name: 'tool_list',
    description: 'List all available tools with install status',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { ok: true, tools: toolInstallerService.list() };
    }
  });
}
