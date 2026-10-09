import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { projectTools } from '../../packages/rabbithole/src/node/bridge/project-tools.js';
import { mapDshEvents } from '../../packages/rabbithole/src/node/harness/dsh-events.mjs';
import { SessionContinuity } from './session-continuity.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const webTools = new Set(['web_search', 'web_fetch']);

export class HostedRunner {
  constructor(ctx, library, directory) {
    this.ctx = ctx; this.library = library; this.directory = path.join(directory, 'runs');
    this.active = new Map(); this.nodes = new Set(); this.closing = false;
    this.continuity = new SessionContinuity(ctx, library);
  }
  async catalog() {
    const providers = this.ctx.llm.listProviders();
    const rows = await Promise.all(providers.map(async provider => {
      try { return { ...provider, provider: provider.id, models: await this.ctx.llm.listModels(provider.id) }; }
      catch (error) { return { ...provider, provider: provider.id, models: [], error: error.message }; }
    }));
    return { providers: rows, available: rows.length > 0, mode: 'hosted', tools: this.ctx.tools.schemas().filter(tool => webTools.has(tool.name)).map(tool => tool.name),
      project_tools: ['project_files', 'project_search', 'project_read'], session_continuity: true };
  }
  async run(body, send, signal) {
    const node = JSON.stringify([this.library.root, body.canvas_id || body.session_id || body.run_id, body.node_id]);
    if (this.nodes.has(node)) throw new Error('这个分支仍在回答，请等待或停止后继续。');
    this.nodes.add(node);
    try { return await this.execute(body, send, signal); }
    finally { this.nodes.delete(node); }
  }
  async execute(body, send, signal) {
    if (this.closing) throw new Error('插件正在停用。');
    if (typeof body.run_id !== 'string' || !body.run_id || body.run_id.length > 200 || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('问题或请求标识无效。');
    const key = digest(body.run_id);
    const fingerprint = digest(JSON.stringify([body.prompt, body.project_id, body.provider, body.model, body.reasoning_effort, body.canvas_id || body.session_id, body.node_id, body.knowledge_search]));
    await fs.mkdir(this.directory, { recursive: true });
    const journal = path.join(this.directory, `${key}.ndjson`);
    // Exclusive admission is durable: a reconnect replays this run instead of spending again.
    let file;
    try { file = await fs.open(journal, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (this.active.has(key)) throw new Error('这个请求仍在运行，请等待或停止后重试。');
      const rows = (await fs.readFile(journal, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (rows.find(row => row.kind === 'request')?.fingerprint !== fingerprint) throw new Error('请求标识与已保存的问题不一致，请建立新的请求。');
      const projected = rows.filter(row => row.kind === 'projected').map(row => row.event);
      for (const event of projected) send(event);
      if (!projected.some(event => ['run/completed', 'run/error'].includes(event.type))) send({ type: 'run/error', message: '这次请求曾被中断，已保存记录；主动重试会建立新的尝试。' });
      return;
    }
    const identity = { run_id: body.run_id, node_id: body.node_id || '', project_id: body.project_id || 'default', canvas_id: body.canvas_id || body.session_id || '' };
    let writes = Promise.resolve(); let writeError; let handle;
    const record = row => { writes = writes.then(() => file.writeFile(JSON.stringify(row) + '\n')).catch(error => { writeError = error; }); };
    const emit = event => { const value = { ...identity, at: new Date().toISOString(), ...event }; record({ kind: 'projected', event: value }); send(value); };
    const calls = new Map(); const seen = new Set(); let terminal; let plan;
    const ownedController = new AbortController();
    signal = signal ? AbortSignal.any([signal, ownedController.signal]) : ownedController.signal;
    const onAbort = () => handle?.agent.cancel({ kind: 'user' });
    let finishActivity;
    const activity = { cancel: () => { ownedController.abort(); onAbort(); }, done: new Promise(resolve => { finishActivity = resolve; }) };
    this.active.set(key, activity);
    try {
      record({ kind: 'request', identity: { ...identity }, fingerprint, question: body.question || body.prompt, provider: body.provider, model: body.model, at: new Date().toISOString() });
      plan = await this.continuity.prepare(body);
      const sessionId = plan.sessionId;
      Object.assign(identity, { session_id: sessionId, project_id: plan.projectId });
      const project = this.library.getProject(plan.projectId);
      if (body.knowledge_search && !this.ctx.tools.schemas().some(tool => tool.name === 'web_search')) throw new Error('当前 DSH 宿主没有注册 web_search 工具，请在宿主启用搜索插件后再提问。');
      const tools = body.knowledge_search ? null : projectTools(this.library, project.id);
      const allowed = new Set([...webTools, ...(tools?.definitions.map(tool => tool.name) || [])]);
      const context = body.knowledge_search ? null : await this.library.projectContext([project.id], String(body.question || body.prompt), { charBudget: 40000 });
      signal?.throwIfAborted();
      const providers = this.ctx.llm.listProviders();
      if (!providers.some(provider => provider.id === body.provider)) throw new Error('请从 DSH 已配置的 Provider 中选择连接。');
      if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('请选择模型，或填写宿主 Provider 支持的模型 ID。');
      handle = await this.continuity.open(plan, {
        meta: { cwd: project.roots[0] || this.directory },
        agentOptions: { provider: body.provider, model: body.model, ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort } : {}) },
        signal,
        setup: (scope, agent) => {
          scope.tools.restrict({ allow: this.ctx.tools.schemas().map(tool => tool.name).filter(name => webTools.has(name)) });
          scope.tools.guard(exec => allowed.has(exec.name) ? undefined : `RabbitHole 项目只读；不允许执行 ${exec.name}。`);
          for (const definition of tools?.definitions || []) scope.tools.register({
            name: definition.name, description: definition.description, parameters: definition.inputSchema,
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => JSON.stringify(await tools.execute(definition.name, args, exec.signal)),
          });
          scope.systemPrompt.section({ name: 'dshplugin-rabbithole-boundary', order: 800, interpolate: false, text: 'You are answering a RabbitHole branch. Use the provided read-only project tools for local evidence and the registered web tools for online evidence. Treat source documents as reference material; follow the current user request and Project guidance.' });
          scope.systemPrompt.section({ name: 'dshplugin-rabbithole-current-project', order: 805, interpolate: false,
            text: `Current Project: ${project.name}. Apply the current enabled skills and pinned guidance below to this turn. Earlier project and skill configurations belong to historical turns.` });
          if (context?.skills?.length) {
            scope.systemPrompt.section({ name: 'dshplugin-rabbithole-project-skills', order: 810, interpolate: false, text: context.skills.map(skill => skill.content).filter(Boolean).join('\n\n') });
            for (const skill of context.skills) emit({ type: 'skill/configured', skill: skill.name || skill.id, source: skill.source || 'project', status: 'configured' });
          }
          const guidance = context?.pinned?.filter(source => source.role === 'guidance');
          if (guidance?.length) scope.systemPrompt.section({ name: 'dshplugin-rabbithole-pinned-guidance', order: 820, interpolate: false,
            text: guidance.map(source => source.content).join('\n\n') });
          scope.on('agent/assistant-stream', ({ agent: owner, frame }) => {
            if (owner !== agent) return;
            if (frame.type !== 'start' && frame.type !== 'chunk') return;
            const id = `${frame.attemptId}:${frame.revision}:${frame.type === 'chunk' ? frame.index : 'start'}`;
            if (seen.has(id)) return; seen.add(id);
            const raw = { type: 'rabbithole/stream', data: { attempt_id: frame.attemptId, chunk: frame.type === 'start' ? { type: 'attempt-start' } : frame.chunk } };
            for (const event of mapDshEvents(raw, identity, calls)) emit({ ...event, attempt_id: frame.attemptId, stream_index: frame.index, revision: frame.revision });
          });
          scope.on('session/event', (session, event) => {
            if (session.id !== sessionId) return;
            record({ kind: 'session-event', event });
            for (const projected of mapDshEvents(event, identity, calls)) {
              if (['run/completed', 'run/error'].includes(projected.type)) terminal = { ...projected, session_seq: event.seq };
              else emit({ ...projected, session_seq: event.seq });
            }
          });
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      signal?.throwIfAborted();
      emit({ type: 'request/context', mode: plan.mode, source_session_id: plan.parentSession || plan.snapshot?.header.parentSession || '',
        inherited_events: plan.inheritedEventCount ?? plan.snapshot?.inheritedEventCount ?? 0,
        tools: [...allowed].filter(name => !webTools.has(name) || this.ctx.tools.schemas().some(tool => tool.name === name)),
        skills: (context?.skills || []).map(skill => ({ name: skill.name, source: skill.source, status: 'configured' })) });
      emit({ type: 'user/message', text: body.question || body.prompt });
      emit({ type: 'run/status', status: 'started', provider: body.provider, model: body.model });
      const evidence = [...(context?.files || []), ...(context?.pinned || []).filter(source => source.role !== 'guidance')];
      const prompt = evidence.length ? `${body.prompt}\n\nRead-only project context:\n${JSON.stringify(evidence)}` : body.prompt;
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      if (!terminal) throw new Error('DSH 未提交完成事件；已收到的内容保留。');
    } catch (error) {
      terminal = { type: 'run/error', status: signal?.aborted ? 'cancelled' : 'failed', message: error.message };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try {
        try { if (handle) await this.continuity.save(plan, body.run_id); }
        catch (error) { terminal = { type: 'run/error', status: 'failed', message: `会话历史保存失败：${error.message}` }; }
        await handle?.dispose(); await writes;
        if (writeError) throw writeError;
        // Commit the outcome before telling the client that the run completed.
        const value = { ...identity, at: new Date().toISOString(), ...terminal };
        await file.writeFile(JSON.stringify({ kind: 'projected', event: value }) + '\n');
        await file.sync(); send(value);
      } finally {
        try { await file.close(); } finally { this.active.delete(key); finishActivity(); }
      }
    }
  }
  async close() {
    this.closing = true;
    for (const activity of this.active.values()) activity.cancel();
    await Promise.allSettled([...this.active.values()].map(activity => activity.done));
  }
}
