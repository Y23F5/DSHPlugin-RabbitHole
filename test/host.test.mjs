import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Sessions from '@deepseek-ai/dsh-session';
import Llm, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as plugin from '../src/host/plugin.mjs';

class FixtureAdapter extends LlmAdapter {
  calls = 0;
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async listModels(provider) { return [{ provider, id: 'fixture', name: '受控模型，不连接外部 API' }]; }
  async *stream(options) {
    this.calls++;
    if (this.calls === 1) {
      assert.ok(options.tools.some(tool => tool.name === 'project_read'));
      assert.ok(!options.tools.some(tool => tool.name === 'write_file'));
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: '检查受控文件。' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '检查受控文件。' } };
      const id = ToolCallId('fixture-read'); const args = JSON.stringify({ path: 'fixture.md' });
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id, name: 'project_read', argumentsDelta: args };
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'project_read', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '已读取受控文件。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已读取受控文件。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

test('official host: selection, project read, thought/tool/body streaming, replay and owned teardown', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshplugin-rabbithole-host-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await ctx.plugin(WebServer, { host: '0.0.0.0', port: 0 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Llm);
  await ctx.plugin(Projections);
  await ctx.plugin(SystemPrompt, { personaPrefix: '' });
  await ctx.plugin(Tools);
  await ctx.plugin(Agents);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new FixtureAdapter(); ctx.llm.registerAdapter(['fixture'], adapter);
  let writes = 0;
  ctx.tools.register({ name: 'write_file', description: 'Blocked fixture', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => { writes++; return 'unreachable'; } });
  const session = ctx.sessions.create('isolated-fixture');
  session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', id: 'answer-fixture', content: [{ type: 'text', text: '# 来自宿主\n\n这是一份受控的来源回答。' }] }, stream: [] }, { surfaceOp: 'append' });
  const fiber = await ctx.plugin(plugin, { port: 0, dataDirectory: path.join(root, 'data') });
  const host = `http://127.0.0.1:${ctx.webServer.port}`;
  assert.equal((await fetch(`${host}/dshplugin-rabbithole/launch`, { method: 'POST' })).status, 403);
  const response = await fetch(`${host}/dshplugin-rabbithole/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole': 'workspace', Origin: host }, body: JSON.stringify({ sessionId: 'isolated-fixture', messageId: 'answer-fixture' }) });
  const launch = await response.json();
  assert.equal(response.status, 200, JSON.stringify(launch));
  const target = new URL(launch.url).origin;
  const connected = await fetch(launch.url, { redirect: 'manual' });
  assert.match(connected.headers.get('location'), /^\/[a-f0-9-]{36}$/);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const rows = await (await fetch(`${target}/api/library`, { headers: { Cookie: cookie } })).json();
  assert.equal(rows.length, 1);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole-Request': 'library' };
  const repo = path.join(root, 'fixture-project'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'fixture.md'), 'Only read this fixture.');
  const projectResponse = await fetch(`${target}/api/library/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '受控项目', roots: [repo] }) });
  const project = await projectResponse.json(); assert.equal(projectResponse.status, 201, JSON.stringify(project));
  const branch = await fetch(`${host}/dshplugin-rabbithole/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole': 'workspace', Origin: host }, body: JSON.stringify({ sessionId: 'isolated-fixture', turn: 1, quote: '受控的来源回答', question: '请读 fixture.md。', projectId: project.id }) });
  assert.equal(branch.status, 200, await branch.clone().text());
  const branchLaunch = await branch.json();
  const redirected = await fetch(branchLaunch.url, { redirect: 'manual' });
  assert.match(redirected.headers.get('location'), /dshplugin_run=question$/);
  const body = { run_id: 'controlled-run', prompt: '请读 fixture.md。', project_id: project.id, provider: 'fixture', model: 'fixture', node_id: 'question' };
  const run = async () => (await (await fetch(`${target}/api/harness/run`, { method: 'POST', headers: { ...headers, 'X-DSHPlugin-RabbitHole-Request': 'harness' }, body: JSON.stringify(body) })).text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const events = await run();
  assert.ok(events.some(row => row.type === 'assistant/reasoning/delta'), JSON.stringify(events));
  assert.ok(events.some(row => row.type === 'tool/call/delta'));
  assert.ok(events.some(row => row.type === 'tool/call' && row.tool === 'project_read'));
  assert.ok(events.some(row => row.type === 'tool/result' && row.status === 'completed' && row.duration_ms >= 0));
  assert.equal(events.at(-1).type, 'run/completed', JSON.stringify(events));
  assert.ok(events.some(row => row.type === 'assistant/text/replace' && row.text.includes('已读取')));
  assert.equal(writes, 0);
  assert.equal(await fs.readFile(path.join(repo, 'fixture.md'), 'utf8'), 'Only read this fixture.');
  assert.equal((await run()).at(-1).type, 'run/completed'); assert.equal(adapter.calls, 2, 'replay must not request the model again');
  await fiber.dispose();
  assert.ok(ctx.sessions.get('isolated-fixture'), 'unloading must not dispose the host session');
  await assert.rejects(() => fetch(`${target}/api/plugin/status`));
  assert.equal((await fetch(`${host}/dshplugin-rabbithole/launch`)).status, 404);
});
