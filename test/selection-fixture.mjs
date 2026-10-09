import fs from 'node:fs/promises';
import path from 'node:path';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';

export async function installSelectionFixture(ctx, runtime) {
  class Adapter extends LlmAdapter {
    calls = 0;
    async resolveModel(provider, model) { return { provider, id: model, name: '本地受控模型' }; }
    async listModels(provider) { return [{ provider, id: 'fixture', name: '本地受控模型' }]; }
    async *stream(options) {
      if (!(options.tools || []).some(tool => tool.name === 'project_read')) {
        const text = '# 实验理解顺序\n\n先理解**长期历史**与训练曲线。\n\n需要先检查数据范围，再阅读评估代码。\n\n最后整理模型结构，保留每一处问题的来源。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      this.calls++;
      if (this.calls % 2 === 1) {
        const thought = '先读取项目文件中的实验说明，再解释所选引用。';
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: thought };
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } };
        const id = ToolCallId(`selection-read-${this.calls}`); const args = JSON.stringify({ path: 'fixture.md' });
        yield { type: 'block-start', index: 1, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 1, id, name: 'project_read', argumentsDelta: args };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'project_read', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = 'TITLE: 从长期历史到训练曲线\n\n# 理解长期历史\n\n长期历史是模型能够利用的先前帧信息。\n\n查看训练曲线时，先确认数据范围、每步 loss 和评估方法。\n\n这是本地受控模型的演示回答，用来检查流式显示和项目读取。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const chunk of text.match(/.{1,12}|\n/g)) { yield { type: 'text-delta', index: 0, text: chunk }; await new Promise(resolve => setTimeout(resolve, 45)); }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const repo = path.join(runtime, 'selection-check', 'project'); await fs.mkdir(repo, { recursive: true });
  const id = 'rabbithole-selection-check-v5';
  const options = { sessionId: id, meta: { cwd: repo }, agentOptions: { provider: 'fixture', model: 'fixture' } };
  const handle = await ctx.get('sessionPersistence')?.stat(id) ? await ctx.agents.resume({ resumeSessionId: id, agentOptions: options.agentOptions }) : await ctx.agents.create(options);
  ctx.effect(() => () => handle.dispose());
  const session = handle.agent.session;
  if (!session.snapshotEvents().some(event => event.type === 'assistant/message')) {
    session.append('model/selection', { provider: 'fixture', model: 'fixture' });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '选文提问交互检查：先理解长期历史。' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
  }
  await ctx.get('sessionPersistence')?.flush();
  await fs.writeFile(path.join(repo, 'fixture.md'), '# 本地实验说明\n\n长期历史指先前视频帧。训练曲线记录每步 loss。\n');
  const host = `http://127.0.0.1:${ctx.webServer.port}`;
  const launch = await (await fetch(`${host}/dshplugin-rabbithole/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole': 'workspace' }, body: '{}' })).json();
  const connect = await fetch(launch.url, { redirect: 'manual' }); const cookie = connect.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-DailyDesk-Request': 'library' };
  const projects = await (await fetch(`${launch.origin}/api/library/projects`, { headers })).json();
  if (!projects.some(project => project.name === '选文提问检查')) await fetch(`${launch.origin}/api/library/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '选文提问检查', roots: [repo] }) });
  console.log('本地交互材料已准备：选文提问交互检查；Project：选文提问检查。');
}
