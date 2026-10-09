import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantSource } from '../src/host/source.mjs';

test('selected formatted text, repeated quote and same-turn answer keep exact source and model', () => {
  const markdown = '# 引用\n\n第一处：**长期历史**需要先看。\n\n第二处：**长期历史**需要画曲线。';
  const events = [
    { type: 'model/selection', data: { provider: 'fixture', model: 'fixture', reasoningEffort: 'high' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '如何理解长期历史？' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Runtime policy snapshot' }], source: { kind: 'runtime-context' } } },
    ...[markdown, '第二条回答也讨论长期历史。'].map((text, i) => ({ type: 'assistant/message', seq: i + 1, data: { turn: 1, message: { id: `answer-${i}`, content: [{ type: 'text', text }] } } })),
  ];
  const sessions = { get: () => ({ snapshotEvents: () => events }) };
  const source = readAssistantSource(sessions, 'fixture', undefined, { turn: 1, quote: '长期历史需要画曲线', prefix: '第二处：', occurrence: 1, answerIndex: 0, answerCount: 2 });
  assert.equal(source.messageId, 'answer-0');
  assert.equal(source.execution.provider, 'fixture');
  assert.equal(source.question, '如何理解长期历史？');
  assert.equal(markdown.slice(source.anchor.offset_start, source.anchor.offset_end), '长期历史**需要画曲线');
  const duplicate = readAssistantSource(sessions, 'fixture', 'answer-0', { quote: '长期历史', occurrence: 1 });
  assert.equal(duplicate.anchor.offset_start, markdown.lastIndexOf('长期历史'));
});
