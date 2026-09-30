import { IdbStore } from './idb-store.js';
import { toPersistedHole } from '../../core/schema.js';
import { readJsonResponse } from './http-response.js';

const META = 'dailydesk-library-v1';
export class LibraryStore extends IdbStore {
  constructor(options) {
    const scope = options?.scope || '';
    super({ ...options, ...(scope ? { dbName: `rabbithole-browser:${scope}` } : {}) });
    this.metaKey = scope ? `${META}:${scope}` : META;
    this.state = { phase: 'loading', message: '正在连接资料库' };
    this.listeners = new Set(); this.envelopes = new Map(); this.saves = new Map();
    this.drafts = new Map(); this.sequences = new Map(); this.conflicts = new Set(); this.uploaded = new Map();
    this.tabId = sessionStorage.getItem('dd-library-tab') || crypto.randomUUID();
    sessionStorage.setItem('dd-library-tab', this.tabId);
    this.journal = new IdbStore({ ...options, dbName: 'dailydesk-pending-drafts' + (scope ? `:${scope}` : '') });
    try { this.metadata = JSON.parse(localStorage.getItem(this.metaKey) || '{}'); } catch { this.metadata = {}; }
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  status(phase, message, detail = {}) { this.state = { ...this.state, phase, message, ...detail }; for (const fn of this.listeners) fn(this.state); }
  remember(id) {
    const other = JSON.parse(localStorage.getItem(this.metaKey) || '{}');
    localStorage.setItem(this.metaKey, JSON.stringify({ ...other, [id]: this.metadata[id] }));
  }
  journalId(id) { return `${id}-draft-${this.tabId}`; }
  async journalWrite(hole) {
    const copy = structuredClone(hole); copy.hole_id = this.journalId(hole.hole_id);
    const root = copy.nodes.find((n) => n.id === copy.root_id);
    root.extensions.dd_draft = { hole_id: hole.hole_id, revision: this.metadata[hole.hole_id]?.revision || 0 };
    await this.journal.saveHole(copy);
  }
  async cachedHole(id) { return this.drafts.get(id) || super.loadHole(id); }
  async pendingDrafts() { return this.journal.listHoles(); }
  async retireDraft(id) {
    const key = this.journalId(id); const draft = await this.journal.loadHole(key);
    if (!draft) return;
    draft.hole_id = `${key}-kept-${crypto.randomUUID().slice(0, 8)}`;
    await this.journal.saveHole(draft); await this.journal.deleteHole(key);
  }
  async recoverDraft(key) {
    const hole = await this.journal.loadHole(key);
    const root = hole.nodes.find((n) => n.id === hole.root_id); const original = root.extensions.dd_draft.hole_id;
    delete root.extensions.dd_draft;
    hole.hole_id = crypto.randomUUID();
    hole.title += ' · 恢复草稿';
    await super.putAssets(hole.hole_id, await this.getAssets(original));
    await this.saveHole(hole);
    if (this.state.phase !== 'saved') throw this.state.error;
    await this.journal.deleteHole(key);
    return hole;
  }
  async request(suffix = '', options = {}) {
    const response = await fetch(`/api/library${suffix}`, {
      signal: AbortSignal.timeout(45000), ...options, headers: { 'X-DailyDesk-Request': 'library', ...(this.directory ? { 'X-DailyDesk-Library': encodeURIComponent(this.directory) } : {}), ...options.headers },
    });
    return readJsonResponse(response);
  }
  async ready() {
    if (!this.readyPromise) this.readyPromise = this.request('/config').then((config) => {
      this.directory = config.directory;
      this.status('saved', '已连接本地资料库', { directory: config.directory }); return config;
    }).catch((error) => { this.readyPromise = null; this.status('offline', '暂存在浏览器，资料库连接后可继续同步'); throw error; });
    return this.readyPromise;
  }
  async listHoles() {
    const local = await super.listHoles();
    const rows = new Map(local.filter(row => !this.metadata[row.hole_id]?.archived).map(row => [row.hole_id, row]));
    let migrationError = null;
    try {
      await this.ready();
      const remote = await this.request();
      for (const row of remote) rows.set(row.hole_id, row);
      for (const row of local) {
        if (remote.some((r) => r.hole_id === row.hole_id)) continue;
        if (this.metadata[row.hole_id]?.archived) continue;
        if (this.conflicts.has(row.hole_id)) continue;
        try {
          const hole = await super.loadHole(row.hole_id);
          await this.push(hole, 'migration');
        } catch (error) { migrationError = { error, id: row.hole_id }; this.report(error, row.hole_id); }
      }
      for (const row of await this.request()) rows.set(row.hole_id, row);
      if (migrationError) this.report(migrationError.error, migrationError.id);
    } catch (error) { this.report(error); }
    return [...rows.values()];
  }
  async loadHole(id) {
    let cached = await this.cachedHole(id);
    const draft = await this.journal.loadHole(this.journalId(id));
    if (draft) {
      const root = draft.nodes.find((n) => n.id === draft.root_id);
      this.metadata[id] = { revision: root.extensions.dd_draft.revision, pending: true };
      delete root.extensions.dd_draft; draft.hole_id = id; cached = draft;
      this.drafts.set(id, cached);
    }
    try {
      await this.ready();
      if (this.metadata[id]?.pending && cached) { await this.push(cached, 'recovered-draft'); await this.journal.deleteHole(this.journalId(id)); }
      const remote = await this.request(`/${encodeURIComponent(id)}`);
      if (!remote) {
        if (!cached) return null;
        return (await this.push(cached, 'migration')).hole;
      }
      if (cached && !this.metadata[id] && JSON.stringify({ ...cached, updated_at: '' }) !== JSON.stringify({ ...remote.hole, updated_at: '' })) {
        await this.journalWrite(cached); await this.retireDraft(id);
      }
      this.accept(id, remote);
      await super.saveHole(remote.hole);
      return remote.hole;
    } catch (error) { this.report(error, id); if (cached) return cached; throw error; }
  }
  accept(id, result, pending = false) {
    this.envelopes.set(id, result);
    this.metadata[id] = { revision: result.revision, pending };
    this.remember(id);
    if (!pending) this.drafts.delete(id);
    this.status(pending ? 'saving' : 'saved', pending ? '正在保存后续修改' : '已保存到文件', { hole_id: id, citations: result.citations, error: null });
  }
  report(error, id) { if (error.status === 409) this.conflicts.add(id); this.status(error.status === 409 ? 'conflict' : 'offline', error.status === 409 ? error.message : '本页已暂存在浏览器，文件同步尚未完成', { hole_id: id, error }); }
  async push(hole, reason = 'save', sequence = this.sequences.get(hole.hole_id)) {
    await this.ready();
    const assets = await super.getAssets(hole.hole_id);
    for (const asset of assets) {
      const key = `${hole.hole_id}/${asset.name}`;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
      if (this.uploaded.get(key) === hash) continue;
      await this.request(`/${hole.hole_id}/assets/${encodeURIComponent(asset.name)}`, { method: 'PUT', body: asset.blob }); this.uploaded.set(key, hash);
    }
    const result = await this.request(`/${hole.hole_id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hole, revision: this.metadata[hole.hole_id]?.revision || 0, reason }) });
    this.accept(hole.hole_id, result, sequence !== this.sequences.get(hole.hole_id));
    return result;
  }
  async saveHole(value, options) {
    const hole = toPersistedHole(value, options);
    const id = hole.hole_id;
    const root = hole.nodes.find(node => node.id === hole.root_id);
    root.extensions = root.extensions || {};
    root.extensions.dailydesk = { ...root.extensions.dailydesk, project_id: root.extensions.dailydesk?.project_id || (this.metadata[id] ? 'default' : this.projectId || 'default') };
    const sequence = (this.sequences.get(id) || 0) + 1; this.sequences.set(id, sequence);
    this.drafts.set(id, hole);
    await super.saveHole(hole);
    this.metadata[id] = { ...this.metadata[id], pending: true }; this.remember(id);
    await this.journalWrite(hole);
    const operation = (this.saves.get(id) || Promise.resolve()).then(async () => {
      if (this.conflicts.has(id)) return;
      this.status('saving', '正在保存', { hole_id: id });
      try {
        await this.push(hole, 'save', sequence);
        if (this.sequences.get(id) === sequence) await this.journal.deleteHole(this.journalId(id));
        else if (this.drafts.has(id)) await this.journalWrite(this.drafts.get(id));
      } catch (error) { this.report(error, id); }
    });
    this.saves.set(id, operation.catch(() => {}));
    await operation;
  }
  async getAsset(id, name) {
    const cached = await super.getAsset(id, name); if (cached) return cached;
    try {
      const response = await fetch(`/api/library/${id}/assets/${encodeURIComponent(name)}`);
      if (!response.ok) return null;
      const blob = await response.blob(); await super.putAsset(id, name, blob); return blob;
    } catch { return null; }
  }
  async listAssets(id) {
    const local = await super.listAssets(id);
    try { return [...new Set([...local, ...await this.request(`/${id}/assets`)])]; } catch { return local; }
  }
  async getAssets(id) { return (await Promise.all((await this.listAssets(id)).map(async (name) => ({ name, blob: await this.getAsset(id, name) })))).filter((a) => a.blob); }
  async deleteHole(id) {
    await this.saves.get(id);
    const result = await this.request(`/${id}`, { method: 'DELETE' });
    this.metadata[id] = { revision: result.revision, archived: true }; this.remember(id);
    await super.deleteHole(id);
  }
  async reloadDisk(id) {
    const envelope = await this.request(`/${id}`);
    if (!envelope) throw new Error('磁盘画布不存在');
    await this.retireDraft(id);
    this.conflicts.delete(id);
    this.accept(id, envelope); await super.saveHole(envelope.hole); return envelope.hole;
  }
  async saveCopy(id) {
    const hole = structuredClone(await this.cachedHole(id));
    hole.hole_id = crypto.randomUUID();
    hole.title += ' · 副本';
    const assets = await this.getAssets(id); await super.putAssets(hole.hole_id, assets);
    await super.saveHole(hole);
    await this.push(hole, 'conflict-copy');
    await this.reloadDisk(id);
    return hole;
  }
  async history(id, nodeId) { return this.request(`/${id}/history/${nodeId}`); }
  async version(id, nodeId, versionId) { return this.request(`/${id}/version/${nodeId}/${versionId}`); }
  async restore(id, nodeId, versionId) {
    const result = await this.request(`/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId, version_id: versionId, revision: this.metadata[id]?.revision }) });
    this.accept(id, result); await super.saveHole(result.hole); return result.hole;
  }
  async retry(id) {
    this.conflicts.delete(id); await this.saveHole(await this.cachedHole(id));
  }
  async finishRecovery(id) {
    const envelope = await this.request(`/${id}/finish-recovery`, { method: 'POST' });
    await this.retireDraft(id);
    this.conflicts.delete(id); this.accept(id, envelope); await super.saveHole(envelope.hole); return envelope.hole;
  }
}
