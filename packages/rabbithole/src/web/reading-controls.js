import { SETTINGS_KEY, subscribeSettings } from './settings/settings.js';
import { openDialog } from '../ui/primitives/dialog.js';
import { renderHarnessActivity } from '../ui/harness-activity.js';

const option = (value, label) => { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; };
const versionLabels = { migration: '迁移保存', edit: '内容修改', 'answer-or-edit': '回答 / 修改', 'before-change': '修改前', 'external-edit': '外部编辑', restored: '恢复记录', 'recovered-draft': '恢复草稿', save: '保存', removed: '移除前', 'conflict-copy': '另存副本' };
const stateLabels = { ready: '可用', success: '已连接', missing: '尚未安装', signed_out: '需要登录', error: '连接待检查', idle: '正在连接', starting: '正在启动', bridge_down: '桥接未连接', re_pair: '需要重新连接', setup: '需要配置', loading: '正在读取', empty: '暂无模型' };

export function mountReadingControls({ store, controller, current, replace, flush, changed }) {
  const bar = document.createElement('div');
  bar.className = 'dd-reading-controls tb-pill';
  bar.innerHTML = `<select aria-label="回答来源" class="dd-provider"></select><span class="dd-divider"></span><select aria-label="回答模型" class="dd-model"></select><select aria-label="思考程度" class="dd-reasoning" hidden></select><button type="button" class="dd-connection" aria-label="模型连接设置"></button><span class="dd-divider"></span><button type="button" class="dd-files" aria-label="文件与回答版本">文件与版本</button>`;
  document.getElementById('tb-session').prepend(bar);
  const provider = /** @type {HTMLSelectElement} */ (bar.querySelector('.dd-provider'));
  const model = /** @type {HTMLSelectElement} */ (bar.querySelector('.dd-model'));
  const reasoning = /** @type {HTMLSelectElement} */ (bar.querySelector('.dd-reasoning'));
  const connection = /** @type {HTMLButtonElement} */ (bar.querySelector('.dd-connection'));
  const files = /** @type {HTMLButtonElement} */ (bar.querySelector('.dd-files'));
  let activeController;
  const fill = (select, entries, value) => {
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) { select.replaceChildren(...entries.map(([id, label]) => option(id, label))); select.dataset.options = signature; }
    select.value = value || '';
    select.title = select.selectedOptions[0]?.textContent || '';
  };
  const render = (state) => {
    fill(provider, state.rows.map((r) => [r.id, r.label]), state.selected);
    const entries = state.models.map((m) => [m.id, m.name || m.id]);
    if (!entries.some(([id]) => id === state.model)) entries.unshift([state.model || '', state.model ? `${state.model} · 待验证` : '选择模型']);
    fill(model, entries, state.model);
    model.disabled = !state.models.length;
    const names = { low: '轻度思考', medium: '中等思考', high: '深入思考', xhigh: '扩展思考', none: '不额外思考', minimal: '少量思考', max: '充分思考', ultra: '长时思考' };
    fill(reasoning, state.options.map((id) => [id, names[id] || id]), state.reasoning);
    reasoning.hidden = state.options.length < 2;
    connection.textContent = stateLabels[state.state] || '检查连接';
    connection.dataset.ready = String(state.state === 'ready' || state.state === 'success');
  };
  void controller().then((value) => {
    activeController = value;
    value.subscribeQuick(render);
    void value.refreshQuick().catch(() => { connection.textContent = '读取失败 · 设置'; });
  });
  provider.addEventListener('change', () => { activeController?.selectProvider(provider.value); void activeController?.refreshQuick().catch(() => {}); });
  model.addEventListener('change', () => activeController?.selectModel(model.value));
  reasoning.addEventListener('change', () => activeController?.selectReasoning(reasoning.value));
  connection.addEventListener('click', () => activeController?.open({ trigger: connection }));
  subscribeSettings(() => { if (activeController) render(activeController.quickState()); changed(); });
  window.addEventListener('storage', (event) => { if (event.key === SETTINGS_KEY) void activeController?.refreshQuick().catch(() => {}); });
  store.subscribe((state) => {
    files.dataset.phase = state.phase;
    files.textContent = state.phase === 'conflict' ? '文件冲突' : state.phase === 'offline' ? '待同步' : state.phase === 'saving' ? '保存中…' : '文件与版本';
    files.title = state.message;
  });
  files.addEventListener('click', () => { void openLibrary().catch((error) => { files.title = error.message; }); });

  async function openLibrary() {
    await flush();
    const context = current();
    const backdrop = document.createElement('div'); backdrop.className = 'dd-library-backdrop';
    backdrop.innerHTML = `<section class="dd-library"><header><div><p class="dd-eyebrow">本地阅读资料</p><h2>文件与回答版本</h2></div><button type="button" data-action="close" aria-label="关闭文件与版本">关闭</button></header><p class="dd-library-status" role="status"></p><p class="dd-library-path"></p><div class="dd-library-actions"><button type="button" data-action="folder">打开文件夹</button><button type="button" data-action="reload">载入磁盘内容</button><button type="button" data-action="retry">重试同步</button><button type="button" data-action="copy">将本页另存副本</button><button type="button" data-action="recover" hidden>完成中断的保存并保留冲突副本</button></div><div class="dd-history"><label>阅读节点<select aria-label="查看哪个节点的版本"></select></label><div class="dd-history-grid"><div class="dd-history-list" role="group" aria-label="回答历史"></div><div class="dd-version"><p class="dd-version-meta"></p><pre class="dd-version-body" tabindex="0"></pre><button type="button" data-action="restore" disabled>恢复为当前内容</button><details class="dd-citation"><summary>问题与引用来源</summary><p></p><blockquote></blockquote><details><summary>提问时的来源正文</summary><pre></pre></details></details><details class="dd-harness-log"><summary>运行记录</summary><p></p><div class="dd-harness-runs"></div></details></div></div></div></section>`;
    document.body.append(backdrop);
    const panel = backdrop.querySelector('section');
    const status = /** @type {HTMLElement} */ (panel.querySelector('.dd-library-status'));
    const showError = (error) => { status.textContent = error.message; status.dataset.error = 'true'; };
    panel.querySelector('.dd-library-path').textContent = store.state.directory || '资料库暂未连接';
    status.textContent = context.busy ? '回答生成中，可以查看历史；结束生成后可载入或恢复内容。' : store.state.message;
    /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="recover"]')).hidden = !store.state.error?.detail?.interrupted;
    const layer = openDialog({ dialog: panel, backdrop, label: '文件与回答版本', trigger: files, onClose: () => backdrop.remove() });
    panel.querySelector('[data-action="close"]').addEventListener('click', () => layer.close());
    const act = (name, operation, { needsHole = true, replaces = false } = {}) => {
      const button = /** @type {HTMLButtonElement} */ (panel.querySelector(`[data-action="${name}"]`));
      button.disabled = needsHole && !context.id || replaces && context.busy;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await operation(); if (replaces) layer.close(); else status.textContent = store.state.message; }
        catch (error) { showError(error); }
        finally { button.disabled = false; }
      });
    };
    act('folder', () => store.request('/open', { method: 'POST' }), { needsHole: false });
    act('reload', () => replace(() => store.reloadDisk(context.id)), { replaces: true });
    act('retry', async () => { await store.retry(context.id); if (store.state.phase !== 'saved') throw store.state.error; });
    act('copy', () => replace(() => store.saveCopy(context.id)), { replaces: true });
    act('recover', () => replace(() => store.finishRecovery(context.id)), { replaces: true });
    const drafts = await store.pendingDrafts();
    if (drafts.length) {
      const section = document.createElement('div'); section.className = 'dd-library-actions';
      const select = document.createElement('select'); select.setAttribute('aria-label', '本机未同步草稿');
      select.replaceChildren(...drafts.map((d) => option(d.hole_id, `${d.title} · ${new Date(d.updated_at).toLocaleString()}`)));
      const recover = document.createElement('button'); recover.type = 'button'; recover.textContent = '将草稿恢复为新画布'; recover.disabled = context.busy;
      recover.addEventListener('click', async () => { recover.disabled = true; try { await replace(() => store.recoverDraft(select.value)); layer.close(); } catch (error) { showError(error); recover.disabled = false; } });
      section.append(select, recover); panel.querySelector('.dd-library-actions').after(section);
    }
    const nodeSelect = /** @type {HTMLSelectElement} */ (panel.querySelector('.dd-history select'));
    nodeSelect.replaceChildren(...context.nodes.map((n) => option(n.id, n.title || '未命名节点')));
    const versions = panel.querySelector('.dd-history-list');
    const body = panel.querySelector('.dd-version-body');
    const meta = panel.querySelector('.dd-version-meta');
    const restore = /** @type {HTMLButtonElement} */ (panel.querySelector('[data-action="restore"]'));
    let chosen = null; let token = 0;
    restore.addEventListener('click', async () => {
      if (!chosen) return;
      restore.disabled = true;
      try { await replace(() => store.restore(context.id, chosen.node.id, chosen.id)); layer.close(); }
      catch (error) { showError(error); restore.disabled = context.busy; }
    });
    const selectVersion = async (entry, nodeId, currentToken) => {
      const value = await store.version(context.id, nodeId, entry.id);
      if (currentToken !== token) return;
      chosen = value;
      versions.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === entry.id)));
      body.textContent = value.node.markdown || '此版本没有正文。';
      const gen = value.generation;
      meta.textContent = `${new Date(value.at).toLocaleString()}${gen ? ` · ${gen.provider || ''} ${gen.model || ''}${gen.reasoning ? ` · ${gen.reasoning}` : ''}` : ' · 原有文档'} · ${versionLabels[value.reason] || value.reason}`;
      restore.disabled = context.busy || store.state.phase !== 'saved';
      const citation = /** @type {HTMLElement} */ (panel.querySelector('.dd-citation'));
      citation.hidden = !value.node.origin && !value.citation;
      citation.querySelector('p').textContent = value.node.origin?.question || '';
      citation.querySelector('blockquote').textContent = value.citation?.quote || value.node.origin?.selected_text || '';
      citation.querySelector('pre').textContent = value.citation?.source_markdown || '此版本未记录来源正文。';
      const log = /** @type {HTMLElement} */ (panel.querySelector('.dd-harness-log'));
      const events = Array.isArray(gen?.harness_events) ? gen.harness_events : [];
      log.hidden = !events.length;
      log.querySelector('p').textContent = events.length ? `Session ${gen.session_id || '本地'} · Run ${gen.run_id || '未命名'}` : '';
      const labels = {
        'user/message': '提问',
        'request/context': '整理项目上下文',
        'assistant/message': '生成回答',
        'assistant/reasoning/start': '开始思考',
        'assistant/reasoning/delta': '思考过程',
        'assistant/reasoning/end': '思考结束',
        'assistant/text/delta': '回答片段',
        'tool/call/start': '开始调用工具',
        'tool/call/delta': '工具进行中',
        'tool/call/end': '工具调用结束',
        'tool/call': '调用工具',
        'tool/result': '工具返回',
        'approval/request': '等待审批',
        'approval/result': '审批结果',
        'skill/activated': '启用 Skill',
        'file/read': '读取文件',
        'file/write': '写入文件',
        'plan/update': '更新计划',
        'run/started': '开始运行',
        'run/completed': '运行完成',
        'run/error': '运行失败',
      };
      renderHarnessActivity(log.querySelector('.dd-harness-runs'), events, { labels });
    };
    const loadHistory = async () => {
      const currentToken = ++token; const nodeId = nodeSelect.value;
      chosen = null; restore.disabled = true; body.textContent = ''; meta.textContent = ''; versions.textContent = '正在读取…';
      if (!context.id || !nodeId) { versions.textContent = '打开一张画布后，可以在这里查看版本。'; return; }
      const history = await store.history(context.id, nodeId);
      if (currentToken !== token) return;
      nodeSelect.replaceChildren(...history.nodes.map((n) => option(n.id, n.title || '未命名节点'))); nodeSelect.value = nodeId;
      versions.replaceChildren();
      if (history.citation?.state === 'needs-review' || history.citation?.state === 'ambiguous') status.textContent = '来源正文发生了变化，引用需要核对。历史版本仍保留提问时的原文。';
      const labels = { migration: '迁移保存', edit: '内容修改', 'answer-or-edit': '回答 / 修改', 'before-change': '修改前', 'external-edit': '外部编辑', restored: '恢复记录', 'recovered-draft': '恢复草稿', save: '保存', removed: '移除前' };
      for (const entry of history.versions) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.id = entry.id;
        button.textContent = `${new Date(entry.at).toLocaleString()} · ${labels[entry.reason] || entry.reason}`;
        button.addEventListener('click', () => { void selectVersion(entry, nodeId, currentToken).catch(showError); });
        versions.append(button);
      }
      if (history.versions.length) await selectVersion(history.versions[0], nodeId, currentToken);
      else versions.textContent = '完整回答或编辑保存后，会在这里留下版本。';
    };
    nodeSelect.addEventListener('change', () => { void loadHistory().catch(showError); });
    await loadHistory().catch(showError);
  }
}
