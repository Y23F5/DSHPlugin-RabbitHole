import { createHash, randomUUID } from 'node:crypto';
import { toPersistedHole } from '../../packages/rabbithole/src/core/schema.js';
import { marked } from 'marked';

const normalize = text => text.replace(/\s+/g, ' ').trim();
function renderedText(tokens) {
  return tokens.map(token => {
    if (token.type === 'html') return '';
    if (token.items) return renderedText(token.items);
    if (token.type === 'table') return [token.header, ...token.rows].map(row => row.map(cell => renderedText(cell.tokens)).join(' ')).join('\n');
    if (token.tokens) return renderedText(token.tokens) + (['paragraph', 'heading', 'blockquote', 'list_item'].includes(token.type) ? '\n' : '');
    return token.text || (['space', 'br'].includes(token.type) ? '\n' : '');
  }).join('');
}

export function readAssistantSource(sessions, sessionId, messageId, selection = {}) {
  if (typeof sessionId !== 'string') throw new Error('Missing source identity');
  const session = sessions.get(sessionId);
  if (!session) throw new Error('来源会话未载入，请先在 DSH 中打开这条会话。');
  const quote = String(selection.quote || '').trim();
  if (quote.length > 20000) throw new Error('选区过长，请缩小选区。');
  const candidates = session.snapshotEvents().filter(row => row.type === 'assistant/message'
    && (messageId ? row.data.message.id === messageId : Number.isInteger(selection.turn) && row.data.turn === selection.turn)
    && (!quote || normalize(renderedText(marked.lexer(row.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')))).includes(normalize(quote))));
  if (candidates.length !== 1) throw new Error('无法唯一定位选区来源；请等待回答完成，或使用回答旁的 RabbitHole 按钮。');
  const event = candidates[0];
  if (!event) throw new Error('找不到来源回答，未保存不明来源的内容。');
  const markdown = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  if (!markdown.trim()) throw new Error('这条回答没有可导入的正文。');
  const offset = quote ? markdown.indexOf(quote) : -1;
  return { sessionId, messageId: event.data.message.id, turn: event.data.turn, sourceEventSeq: event.seq, markdown, quote,
    anchor: offset >= 0 && markdown.indexOf(quote, offset + 1) < 0 ? { offset_start: offset, offset_end: offset + quote.length } : null,
    hash: createHash('sha256').update(markdown).digest('hex'), capturedAt: new Date().toISOString() };
}

export async function saveSourceCanvas(library, source, { projectId = 'default', question = '' } = {}) {
  library.getProject(projectId);
  question = String(question).trim();
  if (question.length > 20000) throw new Error('问题过长。');
  const id = randomUUID();
  const title = source.markdown.replace(/^#+\s*/, '').split('\n')[0].slice(0, 90) || 'DSH 回答';
  const hole = toPersistedHole({ hole_id: id, root_id: 'source', title, created_at: source.capturedAt, nodes: [{
    id: 'source', parent_id: null, title, markdown: source.markdown, position: { x: 0, y: 0 }, status: 'answered',
    extensions: { dshplugin: { source }, dailydesk: { project_id: projectId } },
  }, ...(question ? [{ id: 'question', parent_id: 'source', title: question.slice(0, 90), markdown: '', position: { x: 620, y: 0 }, status: 'pending',
    origin: { question, selected_text: source.quote, branch_type: source.quote ? 'selection' : 'followup', anchor: source.anchor },
    extensions: { dshplugin: { queued: true, source }, dailydesk: { project_id: projectId } },
  }] : [])] });
  return library.save(hole, 0, 'dsh-source-import');
}
