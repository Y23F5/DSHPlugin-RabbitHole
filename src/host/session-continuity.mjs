import { createHash } from 'node:crypto';
import { buildForkSeed, interruptedTurnClosers } from '@deepseek-ai/dsh-session';

const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = header => Object.fromEntries(['cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']
  .filter(key => header[key] !== undefined).map(key => [key, header[key]]));

export class SessionContinuity {
  constructor(ctx, library) { this.ctx = ctx; this.library = library; }
  async namespace() {
    return JSON.parse(await this.library.text('.dshplugin-rabbithole.json')).libraryId;
  }
  async read(relative) {
    const text = await this.library.text(relative);
    return text ? JSON.parse(text) : null;
  }
  async nodeKey(canvasId, nodeId) { return hash(JSON.stringify([await this.namespace(), canvasId, nodeId])); }
  async prepare(body) {
    const canvasId = body.canvas_id || body.session_id;
    if (!canvasId) return { sessionId: `dshplugin-rh-${hash(body.run_id).slice(0, 32)}`, projectId: body.project_id || 'default', mode: 'new' };
    const saved = await this.library.load(canvasId);
    const node = saved?.hole.nodes.find(row => row.id === body.node_id);
    if (!node) throw new Error('请先保存当前画布和提问节点，再开始回答。');
    const projectId = saved.hole.nodes.find(row => row.id === saved.hole.root_id)?.extensions?.dailydesk?.project_id || node.extensions?.dailydesk?.project_id || 'default';
    if (body.project_id && projectId !== body.project_id) throw new Error('提问与画布所属 Project 不一致，请重新打开画布。');
    const key = await this.nodeKey(canvasId, node.id);
    const file = `.dshplugin/sessions/${key}.json`;
    const previous = await this.read(file);
    const base = { sessionId: `dshplugin-rh-${key.slice(0, 32)}`, file, canvasId, nodeId: node.id, projectId };
    if (previous) return { ...base, mode: 'resume', snapshot: previous };
    if (this.ctx.get('sessionPersistence') && await this.ctx.get('sessionPersistence').stat(base.sessionId)) return { ...base, mode: 'resume' };
    if (body.knowledge_search) return { ...base, mode: 'new' };
    let parent = saved.hole.nodes.find(row => row.id === node.parent_id);
    while (parent) {
      const parentKey = await this.nodeKey(canvasId, parent.id);
      const history = parent.id === node.parent_id && body.parent_run_id
        ? await this.read(`.dshplugin/session-runs/${hash(body.parent_run_id)}.json`)
        : await this.read(`.dshplugin/sessions/${parentKey}.json`);
      if (parent.id === node.parent_id && body.parent_run_id && (!history || history.canvasId !== canvasId || history.nodeId !== parent.id)) throw new Error('父回答的执行历史尚未保存，请稍候重试。');
      if (history?.events?.length) {
        const answer = history.events.findLast(row => row.type === 'assistant/message' && row.seq >= history.inheritedEventCount);
        if (answer) return { ...base, mode: 'fork', parentSession: history.sessionId, boundary: answer.seq,
          inheritedEventCount: answer.seq + 1, seed: buildForkSeed(history.events, answer.seq) };
      }
      const source = parent.extensions?.dshplugin?.source;
      if (source) {
        let capture = source.historyFile && await this.read(source.historyFile);
        // Older canvases can acquire their source prefix from the current host.
        if (!capture) {
          const live = this.ctx.sessions.get(source.sessionId);
          let events = live?.snapshotEvents();
          const persistence = this.ctx.get('sessionPersistence');
          if (!events && persistence && await persistence.stat(source.sessionId)) {
            const stored = await persistence.open(source.sessionId, 'read');
            try { events = (await stored.read()).events; } finally { await stored.close(); }
          }
          if (events) capture = { events, sessionId: source.sessionId, boundary: source.sourceEventSeq };
        }
        if (!capture) throw new Error('来源会话历史尚未保存，请在 DSH 打开来源会话后重试。');
        if (capture.events[capture.boundary]?.data?.message?.id !== source.messageId) throw new Error('来源历史与画布引用不一致。');
        return { ...base, mode: 'fork', parentSession: capture.sessionId, boundary: capture.boundary,
          inheritedEventCount: capture.boundary + 1, seed: buildForkSeed(capture.events, capture.boundary) };
      }
      parent = saved.hole.nodes.find(row => row.id === parent.parent_id);
    }
    return { ...base, mode: 'new' };
  }
  async open(plan, options) {
    const persistence = this.ctx.get('sessionPersistence');
    if (plan.mode === 'resume') {
      if (persistence && await persistence.stat(plan.sessionId)) {
        return this.ctx.agents.resume({ resumeSessionId: plan.sessionId, ...options });
      }
      const snapshot = plan.snapshot;
      if (!snapshot) throw new Error('节点会话历史暂不可用，请重新打开画布。');
      const seed = [...snapshot.events, ...interruptedTurnClosers(snapshot.events)];
      return this.ctx.agents.create({ sessionId: plan.sessionId, seed, meta: { ...metadata(snapshot.header), cwd: options.meta.cwd },
        inheritedEventCount: snapshot.inheritedEventCount, agentOptions: options.agentOptions, setup: options.setup, signal: options.signal });
    }
    return this.ctx.agents.create({ ...options, sessionId: plan.sessionId,
      ...(plan.seed ? { seed: plan.seed, inheritedEventCount: plan.inheritedEventCount,
        meta: { ...options.meta, parentSession: plan.parentSession, isSeeded: true } } : {}) });
  }
  async save(plan, runId) {
    if (!plan.file) return;
    const session = this.ctx.sessions.get(plan.sessionId);
    if (!session) throw new Error('执行历史未载入，无法保存节点会话。');
    await this.ctx.get('sessionPersistence')?.flush();
    const snapshot = JSON.stringify({ sessionId: plan.sessionId, canvasId: plan.canvasId, nodeId: plan.nodeId,
      runId, header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() });
    await this.library.atomic(`.dshplugin/session-runs/${hash(runId)}.json`, snapshot);
    await this.library.atomic(plan.file, snapshot);
  }
}
