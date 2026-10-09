import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { IsolatedLibrary } from '../src/storage/isolated-library.mjs';
import { HostedRunner } from '../src/host/hosted-runner.mjs';
import { readAssistantSource, saveSourceCanvas } from '../src/host/source.mjs';

class Adapter extends LlmAdapter {
  calls = [];
  async resolveModel(provider, id) { return { provider, id, name: id }; }
  async listModels(provider) { return [{ provider, id: 'fixture', name: '本地受控模型' }]; }
  async *stream(options) {
    this.calls.push(options);
    const text = JSON.stringify(options.messages);
    const user = options.messages.findLast(row => row.role === 'user');
    const prompt = user.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const source = prompt === 'ORIGINAL-QUESTION';
    const toolResult = options.messages.at(-1)?.role === 'tool';
    if (!source) {
      assert.match(text, /ORIGINAL-QUESTION/);
      assert.match(text, /SOURCE-EVIDENCE/);
      assert.ok(options.tools.some(row => row.name === 'project_read'));
      assert.ok(!options.tools.some(row => row.name === 'source_evidence'));
      if (prompt.includes('CHILD-QUESTION')) assert.match(text, /BRANCH-ANSWER/);
      if (prompt.includes('SIBLING-QUESTION')) assert.doesNotMatch(text, /CHILD-ANSWER/);
      if (prompt.includes('RESUME-QUESTION')) assert.match(text, /CHILD-ANSWER/);
    }
    if (!toolResult) {
      const id = ToolCallId(`read-${this.calls.length}`);
      const name = source ? 'source_evidence' : 'project_read';
      const args = source ? '{}' : JSON.stringify({ path: 'fixture.md' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const answer = source ? 'SOURCE-ANSWER' : prompt.includes('CHILD-QUESTION') ? 'CHILD-ANSWER' : prompt.includes('RESUME-QUESTION') ? 'RESUME-ANSWER' : prompt.includes('SIBLING-QUESTION') ? 'SIBLING-ANSWER' : 'BRANCH-ANSWER';
      if (!source) assert.match(text, /FILE-EVIDENCE/);
      const output = `TITLE: ${answer}\n\n${answer}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: output };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

test('source history, branch fork, cold resume, siblings and replay use official sessions', { timeout: 25000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshplugin-continuity-'));
  const library = await new IsolatedLibrary(path.join(root, 'library')).init();
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'fixture.md'), 'FILE-EVIDENCE');
  const project = await library.createProject({ name: '会话衔接', roots: [repo] });
  let ctx; let runner;
  t.after(async () => { await runner?.close(); await ctx?.fiber.dispose(); await library.close(); await fs.rm(root, { recursive: true, force: true }); });
  const start = async (durable = true) => {
    ctx = new Context();
    await ctx.plugin(Sessions);
    if (durable) await ctx.plugin(Persistence, { root: path.join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Llm); await ctx.plugin(Projections); await ctx.plugin(SystemPrompt, { personaPrefix: '' });
    await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(AgentLoop, { agents: [] });
    const adapter = new Adapter(); ctx.llm.registerAdapter(['fixture'], adapter);
    ctx.tools.register({ name: 'source_evidence', description: 'Source evidence', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => 'SOURCE-EVIDENCE' });
    runner = new HostedRunner(ctx, library, root);
    return adapter;
  };
  let adapter = await start();
  const sourceAgent = await ctx.agents.create({ sessionId: 'source-fixture', agentOptions: { provider: 'fixture', model: 'fixture' } });
  sourceAgent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ORIGINAL-QUESTION' }], source: { kind: 'user' } }));
  await sourceAgent.agent.whenIdle();
  const answer = sourceAgent.agent.session.snapshotEvents().findLast(row => row.type === 'assistant/message');
  const source = readAssistantSource(ctx.sessions, 'source-fixture', answer.data.message.id);
  assert.equal(source.question, 'ORIGINAL-QUESTION');
  let saved = await saveSourceCanvas(library, source, { projectId: project.id, question: 'BRANCH-QUESTION', sessions: ctx.sessions });
  const canvasId = saved.hole.hole_id;
  const run = async (node, question, runId, parentRunId = '') => {
    const events = [];
    const body = { canvas_id: canvasId, node_id: node, parent_run_id: parentRunId, project_id: project.id, provider: 'fixture', model: 'fixture', prompt: question, question, run_id: runId };
    await runner.run(body, event => events.push(event));
    assert.equal(events.at(-1).type, 'run/completed', JSON.stringify(events));
    return { events, body, sessionId: events.at(-1).session_id };
  };
  const branch = await run('question', 'BRANCH-QUESTION', 'branch-run');
  assert.equal(branch.events.find(row => row.type === 'request/context').mode, 'fork');
  assert.ok(branch.events.some(row => row.type === 'tool/result'));
  const calls = adapter.calls.length; await runner.run(branch.body, () => {}); assert.equal(adapter.calls.length, calls);
  saved.hole.nodes.push(...['child', 'sibling'].map(id => ({ id, parent_id: 'question', title: id, markdown: '', status: 'pending', position: { x: 1200, y: id === 'child' ? 0 : 500 }, origin: { question: `${id}-question` }, extensions: { dailydesk: { project_id: project.id } } })));
  saved = await library.save(saved.hole, saved.revision, 'continuity');
  const child = await run('child', 'CHILD-QUESTION', 'child-run', 'branch-run');
  const sibling = await run('sibling', 'SIBLING-QUESTION', 'sibling-run', 'branch-run');
  assert.notEqual(child.sessionId, sibling.sessionId);
  await sourceAgent.dispose(); await runner.close(); await ctx.fiber.dispose();
  adapter = await start();
  const resumed = await run('child', 'RESUME-QUESTION', 'resume-run');
  assert.equal(resumed.sessionId, child.sessionId);
  assert.equal(resumed.events.find(row => row.type === 'request/context').mode, 'resume');
  await runner.close(); await ctx.fiber.dispose();
  adapter = await start(false);
  const recovered = await run('child', 'RESUME-QUESTION', 'snapshot-recovery-run');
  assert.equal(recovered.sessionId, child.sessionId);
  assert.equal(await fs.readFile(path.join(repo, 'fixture.md'), 'utf8'), 'FILE-EVIDENCE');
});
