import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const name = 'dshplugin-rabbithole-client';
export const inject = ['slots', 'layout'];
export const PANEL_ID = 'dshplugin-rabbithole';

export function apply(ctx) {
  let state = { url: '', error: '', loading: false };
  let pending; let disposed = false;
  let selection = null;
  let rightPane = null;
  const answerButtons = new Set();
  const listeners = new Set();
  const notify = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  async function request(source, signal) {
    const response = await fetch('/dshplugin-rabbithole/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole': 'workspace' }, body: JSON.stringify(source), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '无法打开工作区');
    return value;
  }
  async function open(source = {}) {
    pending?.abort(); pending = new AbortController();
    const request = pending;
    notify({ loading: true, error: '' });
    try {
      const value = await apiRequest(source, request.signal);
      if (disposed || pending !== request) return;
      if (source.question && value.holeId && rightPane?.session() === source.sessionId) {
        rightPane.open(value.holeId); notify({ loading: false }); return value;
      }
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('工作区地址无效');
      notify({ url: url.href, loading: false });
      ctx.layout.selectPanel(PANEL_ID);
      return value;
    } catch (error) { if (!disposed && pending === request && error.name !== 'AbortError') notify({ loading: false, error: error.message }); throw error; }
  }
  const apiRequest = request;
  function Workspace() {
    const [view, setView] = useState(state);
    useEffect(() => { listeners.add(setView); if (!state.url && !state.loading) void open().catch(() => {}); return () => listeners.delete(setView); }, []);
    if (view.error) return <div role="alert" style={{ padding: 24 }}>{view.error}<button onClick={() => open().catch(() => {})}>重新打开</button></div>;
    if (!view.url) return <div role="status" style={{ padding: 24 }}>正在打开 RabbitHole…</div>;
    return <iframe title="DSHPlugin-RabbitHole" src={view.url} style={{ border: 0, width: '100%', height: '100%', display: 'block' }} />;
  }
  function Icon({ size = 20 }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 11C1-3 13-2 11 10M13 10c0-14 13-10 4 3M6 15c0-7 15-7 15 0s-15 8-15 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  function AnswerAction({ messageId, sourceSession }) {
    const ref = useRef(null);
    const [chosen, setChosen] = useState(null);
    const [dialog, setDialog] = useState(null);
    const [question, setQuestion] = useState('');
    const [projectId, setProjectId] = useState('default');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const controller = useRef(null);
    useEffect(() => {
      const entry = { element: ref.current, sourceSession, messageId, choose: setChosen };
      answerButtons.add(entry);
      return () => { answerButtons.delete(entry); controller.current?.abort(); if (selection?.owner === entry) selection = null; };
    }, [messageId, sourceSession]);
    async function ask() {
      controller.current?.abort(); controller.current = new AbortController();
      setBusy(true); setError('');
      try { const value = await apiRequest({ ...chosen.source, preview: true }, controller.current.signal); setDialog({ ...value, source: chosen.source }); setChosen(null); setQuestion(''); setProjectId(value.projects[0]?.id || 'default'); }
      catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
      finally { setBusy(false); }
    }
    const control = { color: 'inherit', background: 'transparent', border: '1px solid #ffffff28', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' };
    return <>
      <button ref={ref} type="button" aria-label="展开 RabbitHole 画布" title="将这条回答保存到 RabbitHole 画布" onClick={() => open({ sessionId: sourceSession, messageId }).catch(() => {})} style={{ color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer', padding: 4 }}><Icon size={17} /></button>
      {chosen && createPortal(<div style={{ position: 'fixed', left: Math.min(chosen.x, window.innerWidth - 280), top: Math.min(chosen.y + 8, window.innerHeight - 100), zIndex: 10000, background: '#202126', color: '#f0f0f0', padding: 6, borderRadius: 10, boxShadow: '0 8px 30px #0005' }} onMouseDown={event => event.preventDefault()}>
        <button style={control} disabled={busy} onClick={ask}>{busy ? '正在定位来源…' : '在 RabbitHole 中提问'}</button>
        <button style={control} aria-label="关闭" onClick={() => setChosen(null)}>×</button>
        {error && <p role="alert" style={{ maxWidth: 270 }}>{error}</p>}
      </div>, document.body)}
      {dialog && createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: '#0006', display: 'grid', placeItems: 'center' }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
        <form role="dialog" aria-modal="true" aria-label="在 RabbitHole 中提问" style={{ background: '#202126', color: '#f0f0f0', padding: 24, borderRadius: 16, width: 'min(540px, 90vw)', boxSizing: 'border-box', display: 'grid', gap: 14 }} onSubmit={async event => { event.preventDefault(); if (busy || !question.trim()) return; setBusy(true); setError(''); try { await open({ ...dialog.source, projectId, question }); setDialog(null); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }} onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(null); }}>
          <strong>从这段回答继续探索</strong>
          <blockquote style={{ margin: 0, padding: '10px 14px', borderLeft: '2px solid #8e93aa', maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#c4c7d0' }}>{dialog.source.quote}</blockquote>
          <label>保存到 Project <select aria-label="保存到 Project" style={{ ...control, background: '#292b32', width: '100%', marginTop: 6 }} value={projectId} onChange={event => setProjectId(event.target.value)}>{dialog.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <textarea autoFocus aria-label="你的问题" value={question} onChange={event => setQuestion(event.target.value)} placeholder="你想弄清楚什么？" rows={4} style={{ ...control, background: '#17191e', resize: 'vertical', cursor: 'text', font: 'inherit' }} />
          {error && <p role="alert">{error}</p>}
          <div style={{ display: 'flex', justifyContent: 'end', gap: 8 }}><button type="button" style={control} disabled={busy} onClick={() => setDialog(null)}>取消</button><button type="submit" style={{ ...control, background: '#454a60' }} disabled={busy || !question.trim()}>{busy ? '正在保存…' : '提问并展开 Canvas'}</button></div>
        </form>
      </div>, document.body)}
    </>;
  }
  // Version-scoped adapter over DSH's semantic DOM markers, never React internals.
  function captureSelection(event) {
    if (event.target?.closest?.('input,textarea,button,[role="dialog"]')) return;
    const value = window.getSelection();
    if (!value || value.isCollapsed || value.rangeCount !== 1) return;
    const range = value.getRangeAt(0);
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    const seat = start?.closest('[data-chat-flow-kind="assistant-step"]');
    if (!seat || seat !== end?.closest('[data-chat-flow-kind="assistant-step"]') || start.closest('[data-turn-process-inline]') || end.closest('[data-turn-process-inline]')) return;
    const turn = Number(seat.dataset.chatTurn); const quote = value.toString().trim();
    if (!Number.isInteger(turn) || !quote || quote.length > 20000) return;
    const matches = [...answerButtons].filter(entry => {
      const tail = entry.element?.closest('[data-turn-tail]');
      const flow = tail?.closest('[data-chat-flow]');
      return Number(tail?.dataset.turnTail) === turn && flow?.contains(seat);
    });
    if (matches.length !== 1) return;
    selection?.owner.choose(null);
    const rect = range.getBoundingClientRect(); const owner = matches[0];
    selection = { owner }; owner.choose({ source: { sessionId: owner.sourceSession, turn, quote }, x: Math.max(8, rect.left), y: rect.bottom });
  }
  ctx.effect(() => {
    document.addEventListener('mouseup', captureSelection); document.addEventListener('keyup', captureSelection);
    return () => { document.removeEventListener('mouseup', captureSelection); document.removeEventListener('keyup', captureSelection); answerButtons.clear(); };
  }, 'DSHPlugin-RabbitHole: answer selection');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workspace));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: 'RabbitHole' }, Icon));
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: PANEL_ID, order: 15, inject: sessionId => ({ sourceSession: sessionId }) }, AnswerAction));
  // Optional native docking fiber. Its absent services never block the main workspace.
  ctx.plugin({ name: 'dshplugin-rabbithole-right-pane', inject: ['sidebarRightTabs', 'sidebarRight'], apply(scope) {
    const kind = PANEL_ID; const id = `${PANEL_ID}/canvas`;
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind, title: () => 'RabbitHole Canvas' }));
    function CanvasTab({ useTabInfo }) {
      const { tab } = useTabInfo(); const params = tab.navigation.params;
      const [view, setView] = useState({});
      useEffect(() => {
        const abort = new AbortController();
        if (params?.holeId) apiRequest({ holeId: params.holeId, queued: params.queued }, abort.signal).then(value => setView({ url: value.url })).catch(error => { if (error.name !== 'AbortError') setView({ error: error.message }); });
        return () => abort.abort();
      }, [params?.holeId, tab.navigation.revision]);
      if (view.error) return <p role="alert">{view.error}</p>;
      return <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}><button style={{ padding: 8 }} onClick={() => open({ holeId: params.holeId }).catch(() => {})}>在工作区打开</button>{view.url && <iframe title="RabbitHole Canvas" src={view.url} style={{ flex: 1, border: 0, width: '100%', minHeight: 0 }} />}</div>;
    }
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: id }, CanvasTab));
    scope.effect(() => {
      rightPane = { session: () => scope.sidebarRight.mounted.getSnapshot(), open: holeId => scope.sidebarRight.openTab(kind, { params: { holeId, queued: true } }) };
      return () => { rightPane = null; };
    });
  } });
  ctx.effect(() => () => { disposed = true; pending?.abort(); listeners.clear(); }, 'DSHPlugin-RabbitHole: client lifecycle');
}
