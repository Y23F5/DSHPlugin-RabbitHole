import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './style.css';

export const name = 'dshplugin-rabbithole-client';
export const inject = ['slots', 'layout'];
export const PANEL_ID = 'dshplugin-rabbithole';
const PROJECT_KEY = 'dshplugin-rabbithole-project';
const normalized = text => text.replace(/\s+/g, ' ').trim();

export function apply(ctx) {
  let state = { url: '', error: '', loading: false };
  let canvas = null; let pending; let disposed = false; let selection; let rightPane;
  let frameOrigin = ''; let selectedProject = localStorage.getItem(PROJECT_KEY) || 'default';
  const answerButtons = new Set(); const listeners = new Set(); const frames = new Set();
  const notify = patch => { state = { ...state, ...patch }; for (const update of listeners) update({ state, canvas }); };
  const showCanvas = value => { canvas = value; notify({}); };
  async function request(source, signal) {
    const response = await fetch('/dshplugin-rabbithole/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSHPlugin-RabbitHole': 'workspace' }, body: JSON.stringify(source), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '无法打开工作区');
    return value;
  }
  function rememberProject(id) { selectedProject = id; localStorage.setItem(PROJECT_KEY, id); }
  async function open(source = {}) {
    pending?.abort(); pending = new AbortController(); const operation = pending;
    notify({ loading: true, error: '' });
    try {
      const value = await request(source, operation.signal);
      if (disposed || pending !== operation) return;
      const url = new URL(value.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('工作区地址无效');
      frameOrigin = url.origin;
      if (source.question && value.holeId) {
        notify({ loading: false });
        if (rightPane?.session() === source.sessionId) rightPane.open(value.holeId);
        else showCanvas({ url: url.href, holeId: value.holeId, source, title: source.question });
      } else {
        showCanvas(null); notify({ url: url.href, holeId: value.holeId, source: value.source, loading: false }); ctx.layout.selectPanel(PANEL_ID);
      }
      return value;
    } catch (error) {
      if (!disposed && pending === operation && error.name !== 'AbortError') notify({ loading: false, error: error.message });
      throw error;
    }
  }
  function useView() {
    const [view, setView] = useState({ state, canvas });
    useEffect(() => { listeners.add(setView); return () => listeners.delete(setView); }, []);
    return view;
  }
  function Frame({ url, title = 'DSHPlugin-RabbitHole' }) {
    const ref = useRef(null);
    useEffect(() => { const frame = ref.current; frames.add(frame); return () => frames.delete(frame); }, []);
    return <iframe ref={ref} title={title} src={url} className="rh-dsh-frame" />;
  }
  function Workspace() {
    const { state: view } = useView();
    useEffect(() => { if (!state.loading) void open(state.holeId ? { holeId: state.holeId } : {}).catch(() => {}); }, []);
    if (view.error) return <div className="rh-dsh-notice" role="alert">{view.error}<button onClick={() => open().catch(() => {})}>重新打开</button></div>;
    if (!view.url) return <div className="rh-dsh-notice" role="status">正在打开 RabbitHole…</div>;
    return <div className="rh-dsh-tab">{view.source && <div className="rh-dsh-canvas-head"><button onClick={() => returnToSource(view.source)}>返回 DSH 来源</button></div>}<Frame url={view.url} /></div>;
  }
  function Icon({ size = 20 }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 11C1-3 13-2 11 10M13 10c0-14 13-10 4 3M6 15c0-7 15-7 15 0s-15 8-15 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  function returnToSource(source) {
    const workspace = ctx.get('uiWorkspace');
    if (workspace) workspace.openSession(source.sessionId);
    else ctx.layout.selectPanel('conversation');
    showCanvas(null);
    const reveal = () => {
      const seats = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')];
      const seat = seats.find(item => source.seatKey && item.dataset.chatNodeKey === source.seatKey)
        || seats.find(item => Number(item.dataset.chatTurn) === source.turn && (!source.quote || normalized(item.textContent || '').includes(normalized(source.quote))));
      if (!seat) return false;
      seat.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      seat.classList.add('rh-dsh-source-target'); setTimeout(() => seat.classList.remove('rh-dsh-source-target'), 1800); return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) { observer.disconnect(); clearTimeout(timer); } });
    observer.observe(document.body, { childList: true, subtree: true }); const timer = setTimeout(() => observer.disconnect(), 8000);
  }
  function Companion() {
    const { canvas: view } = useView();
    if (!view) return null;
    return <aside className="rh-dsh-companion" aria-label="RabbitHole 分支画布">
      <header className="rh-dsh-canvas-head"><Icon /><div><strong>RabbitHole</strong><small>{view.title}</small></div>
        <button onClick={() => returnToSource(view.source)}>返回来源</button>
        <button aria-label="在工作区打开画布" onClick={() => open({ holeId: view.holeId, queued: true }).catch(() => {})}>↗</button>
        <button aria-label="收起画布" onClick={() => showCanvas(null)}>×</button>
      </header><Frame url={view.url} title="RabbitHole Canvas" />
    </aside>;
  }
  function AnswerAction({ messageId, sourceSession }) {
    const ref = useRef(null); const form = useRef(null);
    const [chosen, setChosen] = useState(null); const [dialog, setDialog] = useState(null);
    const [question, setQuestion] = useState(''); const [projectId, setProjectId] = useState('default');
    const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const controller = useRef(null);
    useEffect(() => {
      const entry = { element: ref.current, sourceSession, messageId, choose: setChosen }; answerButtons.add(entry);
      return () => { answerButtons.delete(entry); controller.current?.abort(); if (selection?.owner === entry) selection = null; };
    }, [messageId, sourceSession]);
    useEffect(() => { if (dialog) form.current?.querySelector('textarea')?.focus(); }, [dialog]);
    async function ask(source) {
      if (busy) return; controller.current?.abort(); controller.current = new AbortController(); setBusy(true); setError('');
      try {
        const value = await request({ ...source, preview: true }, controller.current.signal);
        setDialog({ ...value, locator: { ...source, messageId: value.source.messageId } }); setChosen(null); setQuestion('');
        setProjectId(value.projects.some(project => project.id === selectedProject) ? selectedProject : value.projects[0]?.id || 'default');
      } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
      finally { setBusy(false); }
    }
    return <>
      <button ref={ref} type="button" className="rh-dsh-icon" aria-label="在 RabbitHole 中继续提问" title="从这条回答继续提问" onClick={() => ask({ sessionId: sourceSession, messageId })}><Icon size={17} /></button>
      {error && !dialog && !chosen && <span role="alert" className="rh-dsh-inline-error">{error}</span>}
      {chosen && createPortal(<div className="rh-dsh-selection" style={{ left: Math.max(8, Math.min(chosen.x, window.innerWidth - 260)), top: Math.max(8, Math.min(chosen.y + 8, window.innerHeight - 100)) }} onMouseDown={event => event.preventDefault()}>
        <button disabled={busy} onClick={() => ask(chosen.source)}><Icon size={16} />{busy ? '正在定位引用…' : '继续提问'}</button>
        <button aria-label="收起提问入口" onClick={() => setChosen(null)}>×</button>{error && <p role="alert">{error}</p>}
      </div>, document.body)}
      {dialog && createPortal(<div className="rh-dsh-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !busy) { setDialog(null); ref.current?.focus(); } }}>
        <form ref={form} className="rh-dsh-question" role="dialog" aria-modal="true" aria-label="从引用继续提问" onSubmit={async event => {
          event.preventDefault(); if (busy || !question.trim()) return; setBusy(true); setError('');
          try { rememberProject(projectId); await open({ ...dialog.locator, projectId, question }); setDialog(null); }
          catch (failure) { setError(failure.message); } finally { setBusy(false); }
        }} onKeyDown={event => {
          if (event.key === 'Escape' && !busy) { event.stopPropagation(); setDialog(null); ref.current?.focus(); }
          if (event.key === 'Tab') {
            const controls = [...form.current.querySelectorAll('button,select,textarea')].filter(element => !element.disabled);
            const next = event.shiftKey ? controls.at(-1) : controls[0]; const edge = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === edge) { event.preventDefault(); next.focus(); }
          }
        }}>
          <header><Icon /><strong>继续探索这段回答</strong><button type="button" aria-label="关闭提问" disabled={busy} onClick={() => { setDialog(null); ref.current?.focus(); }}>×</button></header>
          <blockquote>{dialog.source.quote || dialog.source.markdown.slice(0, 600)}</blockquote>
          <textarea aria-label="你的问题" value={question} onChange={event => setQuestion(event.target.value)} placeholder="你想弄清楚什么？" rows={4} />
          <footer><label>项目 <select aria-label="保存到 Project" value={projectId} onChange={event => setProjectId(event.target.value)}>{dialog.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <button type="submit" className="rh-dsh-primary" disabled={busy || !question.trim()}>{busy ? '正在创建分支…' : '提问并展开画布'}</button></footer>
          {dialog.source.execution && <small className="rh-dsh-route">沿用当前会话：{dialog.source.execution.provider} / {dialog.source.execution.model}</small>}
          {error && <p role="alert">{error}</p>}
        </form>
      </div>, document.body)}
    </>;
  }
  function captureSelection(event) {
    if (event.target?.closest?.('input,textarea,button,[role="dialog"],.rh-dsh-selection,.rh-dsh-companion')) return;
    const value = window.getSelection();
    if (!value || value.isCollapsed || value.rangeCount !== 1) { selection?.owner.choose(null); return; }
    const range = value.getRangeAt(0); const element = node => node.nodeType === 1 ? node : node.parentElement;
    const start = element(range.startContainer); const end = element(range.endContainer);
    const seat = start?.closest('[data-chat-flow-kind="assistant-step"]');
    if (!seat || seat !== end?.closest('[data-chat-flow-kind="assistant-step"]') || start.closest('[data-turn-process-inline],details') || end.closest('[data-turn-process-inline],details')) return;
    const turn = Number(seat.dataset.chatTurn); const quote = value.toString().trim();
    if (!Number.isInteger(turn) || !quote || quote.length > 20000) return;
    const matches = [...answerButtons].filter(entry => {
      const tail = entry.element?.closest('[data-turn-tail]'); return Number(tail?.dataset.turnTail) === turn && tail?.closest('[data-chat-flow]')?.contains(seat);
    });
    if (matches.length !== 1) return;
    const before = range.cloneRange(); before.selectNodeContents(seat); before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange(); after.selectNodeContents(seat); after.setStart(range.endContainer, range.endOffset);
    const prefix = normalized(before.toString()); const suffix = normalized(after.toString());
    const normalizedQuote = normalized(quote); let occurrence = 0; let at = 0;
    while ((at = prefix.indexOf(normalizedQuote, at)) >= 0) { occurrence++; at += normalizedQuote.length; }
    const flow = seat.closest('[data-chat-flow]');
    const allSeats = [...flow.querySelectorAll('[data-chat-flow-kind="assistant-step"]')].filter(item => Number(item.dataset.chatTurn) === turn && item.dataset.chatGroupPart !== 'reasoning');
    const keys = [...new Set(allSeats.map(item => item.dataset.chatNodeKey))];
    selection?.owner.choose(null); const owner = matches[0]; selection = { owner }; const rect = range.getBoundingClientRect();
    owner.choose({ source: { sessionId: owner.sourceSession, turn, quote, prefix: prefix.slice(-100), suffix: suffix.slice(0, 100), occurrence, seatKey: seat.dataset.chatNodeKey,
      answerIndex: keys.indexOf(seat.dataset.chatNodeKey), answerCount: keys.length }, x: rect.left, y: rect.bottom });
  }
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style);
    const message = event => {
      const sender = [...frames].find(frame => frame.contentWindow === event.source);
      if (event.origin !== frameOrigin || !sender) return;
      const value = event.data;
      if (value?.type === 'dshplugin/project') rememberProject(value.projectId);
      if (value?.type === 'dshplugin/source') returnToSource(value.source);
      if (value?.type === 'dshplugin/canvas' && value.url?.startsWith(frameOrigin + '/')) {
        // Cache the connected URL for later mounts; keep the live iframe intact.
        if (sender.closest('.rh-dsh-companion') && canvas) showCanvas({ ...canvas, canonicalUrl: value.url, source: value.source || canvas.source });
        else if (sender.title === 'DSHPlugin-RabbitHole' && state.url) notify({ canonicalUrl: value.url, holeId: value.holeId, source: value.source });
      }
    };
    window.addEventListener('message', message); document.addEventListener('mouseup', captureSelection); document.addEventListener('keyup', captureSelection);
    return () => { style.remove(); window.removeEventListener('message', message); document.removeEventListener('mouseup', captureSelection); document.removeEventListener('keyup', captureSelection); answerButtons.clear(); };
  }, 'DSHPlugin-RabbitHole: reading interactions');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workspace));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: PANEL_ID }, Companion));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: 'RabbitHole' }, Icon));
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: PANEL_ID, order: 15, inject: sessionId => ({ sourceSession: sessionId }) }, AnswerAction));
  ctx.plugin({ name: 'dshplugin-rabbithole-right-pane', inject: ['sidebarRightTabs', 'sidebarRight'], apply(scope) {
    const kind = PANEL_ID; const id = `${PANEL_ID}/canvas`;
    const addressPrefix = 'dsh-resource://rabbithole/';
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind, patterns: [addressPrefix + '**'], canOpen: address => address.startsWith(addressPrefix), title: () => 'RabbitHole Canvas' }));
    function CanvasTab({ useTabInfo }) {
      const { tab } = useTabInfo(); const params = tab.navigation.params; const [view, setView] = useState({});
      const holeId = tab.navigation.address?.startsWith(addressPrefix) ? tab.navigation.address.slice(addressPrefix.length) : params?.holeId;
      useEffect(() => {
        const abort = new AbortController();
        if (holeId) request({ holeId, queued: params?.queued }, abort.signal).then(value => { frameOrigin = value.origin; setView({ url: value.url, source: value.source }); }).catch(error => { if (error.name !== 'AbortError') setView({ error: error.message }); });
        return () => abort.abort();
      }, [holeId, tab.navigation.revision]);
      if (view.error) return <p role="alert">{view.error}</p>;
      return <div className="rh-dsh-tab"><div className="rh-dsh-canvas-head">{view.source && <button onClick={() => returnToSource(view.source)}>返回 DSH 来源</button>}<button onClick={() => open(holeId ? { holeId } : {}).catch(() => {})}>在工作区打开</button></div>{view.url && <Frame url={view.url} title="RabbitHole Canvas" />}</div>;
    }
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: id }, CanvasTab));
    scope.effect(() => {
      rightPane = { session: () => scope.sidebarRight.mounted.getSnapshot(), open: holeId => scope.sidebarRight.openResource(addressPrefix + holeId, { params: { queued: true } }) };
      return () => { rightPane = null; };
    });
  } });
  ctx.effect(() => () => { disposed = true; pending?.abort(); listeners.clear(); }, 'DSHPlugin-RabbitHole: client lifecycle');
}
