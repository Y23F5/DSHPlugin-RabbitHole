import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { ReadingLibrary, LibraryError } from './reading-library.mjs';
import { resolveDirectory, SERVICE_NAME } from '../shared/identity.mjs';

// Keep .dailydesk as a file-format namespace; ownership lives in a distinct marker.
export async function claimDirectory(directory) {
  const requested = resolveDirectory(directory);
  await fs.mkdir(requested, { recursive: true });
  const root = await fs.realpath(requested);
  const marker = path.join(root, '.dshplugin-rabbithole.json');
  try {
    const identity = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (identity.service !== SERVICE_NAME || typeof identity.libraryId !== 'string') throw new Error('资料库标识不匹配。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await fs.readdir(root)).length) throw new Error('目标目录已有其它资料，请选择空目录。旧 RabbitHole 的导入将通过独立迁移操作完成。');
    await fs.writeFile(marker, JSON.stringify({ service: SERVICE_NAME, libraryId: randomUUID(), format: 1 }), { flag: 'wx' });
  }
  return root;
}

async function lockDirectory(root) {
  let acquired, failed, release;
  const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const held = new Promise(resolve => { release = resolve; });
  const task = withFileLock(path.join(root, '.dshplugin-rabbithole'), async () => {
    acquired();
    await held;
  }, { waitMs: 200 });
  task.catch(error => failed(error.message.includes('timed out') ? new LibraryError('这个资料库已有运行锁，请关闭正在使用它的工作区后重试。', 409) : error));
  await ready;
  return async () => { release(); await task; };
}

export class IsolatedLibrary extends ReadingLibrary {
  releases = [];
  async init() {
    if (this.configFile) {
      try { this.root = JSON.parse(await fs.readFile(this.configFile, 'utf8')).directory || this.root; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.root = await claimDirectory(this.root);
    this.workspaceRoot = this.root;
    const release = await lockDirectory(this.root);
    try { await super.init(); this.releases.push(release); return this; }
    catch (error) { await release(); throw error; }
  }
  async setRoot(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw new LibraryError('请输入资料库目录。', 400);
    const resolved = resolveDirectory(directory.trim());
    if (resolved === this.root) return this.root;
    const canonical = await fs.realpath(resolved).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (canonical && (canonical === this.root || (process.platform === 'win32' && canonical.toLowerCase() === this.root.toLowerCase()))) return this.root;
    if (this.switching) throw new LibraryError('正在切换资料库，请稍候。', 409);
    this.switching = true;
    let next;
    try {
      await this.beforeRootChange?.();
      await Promise.all([...this.queues.values()]);
      next = await new IsolatedLibrary(resolved).init();
      if (this.configFile) {
        await fs.mkdir(path.dirname(this.configFile), { recursive: true });
        const temporary = `${this.configFile}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ directory: next.root }));
          await fs.rename(temporary, this.configFile);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      const previous = this.releases;
      this.root = next.root;
      this.workspaceRoot = next.workspaceRoot;
      this.projects = next.projects;
      this.releases = next.releases.splice(0);
      for (const release of previous) await release();
      return this.root;
    } finally {
      await next?.close();
      this.switching = false;
    }
  }
  async close() {
    await Promise.allSettled([...this.queues.values()]);
    for (const release of this.releases.splice(0)) await release();
  }
}
