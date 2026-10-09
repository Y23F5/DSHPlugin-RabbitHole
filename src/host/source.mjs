import { createHash, randomUUID } from 'node:crypto';
import { toPersistedHole } from '../../packages/rabbithole/src/core/schema.js';
import { marked } from 'marked';

const normalize = text => text.replace(/\s+/g, ' ').trim();
// Keep Markdown offsets alongside rendered text, including nested inline formatting.
export function projectMarkdown(markdown) {
  let text = ''; const offsets = [];
  const append = (value, start) => { for (let i = 0; i < value.length; i++) { text += value[i]; offsets.push(start + i); } };
  function walk(tokens, base = 0, container = markdown) {
    let cursor = 0;
    for (const token of tokens) {
      const raw = token.raw || token.text || '';
      const found = container.indexOf(raw, cursor);
      const at = found < 0 ? cursor : found;
      const start = base + at;
      if (token.type === 'html' || token.type === 'image') { cursor = at + raw.length; continue; }
      if (token.items) walk(token.items, start, raw);
      else if (token.type === 'table') {
        const cells = [token.header, ...token.rows].flat(); let cellCursor = 0;
        for (const cell of cells) {
          const cellAt = raw.indexOf(cell.text, cellCursor);
          walk(cell.tokens, start + Math.max(0, cellAt), cell.text);
          cellCursor = Math.max(0, cellAt) + cell.text.length; append(' ', start + cellCursor);
        }
      } else if (token.tokens) walk(token.tokens, start, raw);
      else if (token.text) {
        const inner = raw.indexOf(token.text);
        append(token.text, start + Math.max(0, inner));
      } else if (['space', 'br'].includes(token.type)) append(' ', start);
      if (['paragraph', 'heading', 'blockquote', 'list_item', 'code'].includes(token.type)) append(' ', start + raw.length);
      cursor = at + raw.length;
    }
  }
  walk(marked.lexer(markdown));
  let normalized = ''; const mapped = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (normalized && !normalized.endsWith(' ')) { normalized += ' '; mapped.push(offsets[i]); }
    } else { normalized += text[i]; mapped.push(offsets[i]); }
  }
  return { text: normalized.trimEnd(), offsets: mapped };
}

function quoteAnchor(markdown, selection) {
  const projection = projectMarkdown(markdown); const quote = normalize(selection.quote || '');
  if (!quote) return null;
  const positions = []; let cursor = 0;
  while ((cursor = projection.text.indexOf(quote, cursor)) >= 0) { positions.push(cursor); cursor += quote.length; }
  const prefix = normalize(selection.prefix || ''); const suffix = normalize(selection.suffix || '');
  const contextual = positions.filter(at => (!prefix || normalize(projection.text.slice(0, at)).endsWith(prefix))
    && (!suffix || normalize(projection.text.slice(at + quote.length)).startsWith(suffix)));
  const at = contextual.length === 1 ? contextual[0] : positions.length === 1 ? positions[0]
    : Number.isInteger(selection.occurrence) ? positions[selection.occurrence] : undefined;
  if (at === undefined) return null;
  return { offset_start: projection.offsets[at], offset_end: projection.offsets[at + quote.length - 1] + 1,
    rendered_start: at, rendered_end: at + quote.length, occurrence: positions.indexOf(at), prefix, suffix };
}

export function readAssistantSource(sessions, sessionId, messageId, selection = {}) {
  if (typeof sessionId !== 'string') throw new Error('Missing source identity');
  const session = sessions.get(sessionId);
  if (!session) throw new Error('来源会话未载入，请先在 DSH 中打开这条会话。');
  const quote = String(selection.quote || '').trim();
  if (quote.length > 20000) throw new Error('选区过长，请缩小选区。');
  const rows = session.snapshotEvents();
  let candidates = rows.filter(row => row.type === 'assistant/message'
    && (messageId ? row.data.message.id === messageId : Number.isInteger(selection.turn) && row.data.turn === selection.turn));
  if (!messageId && Number.isInteger(selection.answerIndex) && candidates.length === selection.answerCount) candidates = candidates.slice(selection.answerIndex, selection.answerIndex + 1);
  candidates = candidates.filter(row => !quote || projectMarkdown(row.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).text.includes(normalize(quote)));
  if (candidates.length !== 1) throw new Error('无法唯一定位选区来源；请等待回答完成，或使用回答旁的 RabbitHole 按钮。');
  const event = candidates[0];
  if (!event) throw new Error('找不到来源回答，未保存不明来源的内容。');
  const markdown = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  if (!markdown.trim()) throw new Error('这条回答没有可导入的正文。');
  const selected = rows.findLast(row => row.type === 'model/selection')?.data;
  const execution = selected?.provider && selected?.model ? { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort || '' } : null;
  const user = rows.slice(0, rows.indexOf(event) + 1).findLast(row => row.type === 'user/message'
    && (!row.data.source || row.data.source.kind === 'user'));
  const question = user?.data?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
  return { sessionId, messageId: event.data.message.id, turn: event.data.turn, sourceEventSeq: event.seq, markdown, quote,
    question, anchor: quoteAnchor(markdown, selection), seatKey: String(selection.seatKey || ''), execution,
    hash: createHash('sha256').update(markdown).digest('hex'), capturedAt: new Date().toISOString() };
}

export async function saveSourceCanvas(library, source, { projectId = 'default', question = '', sessions } = {}) {
  library.getProject(projectId);
  question = String(question).trim();
  if (question.length > 20000) throw new Error('问题过长。');
  const id = randomUUID();
  if (sessions) {
    const events = sessions.get(source.sessionId)?.snapshotEvents().slice(0, source.sourceEventSeq + 1);
    if (!events || events.at(-1)?.data?.message?.id !== source.messageId) throw new Error('来源回答发生变化，请重新选择。');
    const historyFile = `.dshplugin/sources/${id}.json`;
    await library.atomic(historyFile, JSON.stringify({ sessionId: source.sessionId, boundary: source.sourceEventSeq, events }));
    source = { ...source, historyFile };
  }
  const title = source.markdown.replace(/^#+\s*/, '').split('\n')[0].slice(0, 90) || 'DSH 回答';
  const hole = toPersistedHole({ hole_id: id, root_id: 'source', title, created_at: source.capturedAt, nodes: [{
    id: 'source', parent_id: null, title, markdown: source.markdown, position: { x: 0, y: 0 }, status: 'answered',
    origin: source.question ? { question: source.question, branch_type: 'followup' } : undefined,
    extensions: { dshplugin: { source }, dailydesk: { project_id: projectId } },
  }, ...(question ? [{ id: 'question', parent_id: 'source', title: question.slice(0, 90), markdown: '', position: { x: 620, y: 0 }, status: 'pending',
    origin: { question, selected_text: source.quote, branch_type: source.quote ? 'selection' : 'followup', anchor: source.anchor },
    extensions: { dshplugin: { queued: true, source, execution: source.execution }, dailydesk: { project_id: projectId } },
  }] : [])] });
  return library.save(hole, 0, 'dsh-source-import');
}
