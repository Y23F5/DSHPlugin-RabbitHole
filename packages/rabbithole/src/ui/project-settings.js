import { escapeHtml } from '../core/utils.js';
import { openSettingsSheet } from './settings-sheet.js';
import { readJsonResponse } from '../web/store/http-response.js';

const ACTIVE_KEY = 'rh-active-project';
let projects = [];
let active = localStorage.getItem(ACTIVE_KEY) || 'default';
let changing = false;
let switchProject = null;
export const activeProjectId = () => active;
export const projectOfHole = hole => hole?.nodes?.find(node => node.id === hole.root_id)?.extensions?.dailydesk?.project_id || 'default';

export async function projectRequest(path, options = {}) {
  const response = await fetch(`/api/library/${path}`, {
    signal: AbortSignal.timeout(45000), ...options,
    headers: { 'X-DailyDesk-Request': 'library', 'Content-Type': 'application/json', ...options.headers },
  });
  return readJsonResponse(response);
}

export async function loadProjectContext({ context, projectId = active } = {}) {
  const query = [context?.question, context?.selected_text?.slice(0, 1200), context?.parent_title].filter(Boolean).join('\n');
  return projectRequest('projects/context', { method: 'POST', body: JSON.stringify({ project_ids: [projectId], q: query }) });
}

function syncProjectChrome() {
  const select = document.getElementById('workspace-project');
  if (select) {
    select.innerHTML = projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
    select.value = active; select.disabled = changing;
  }
  document.querySelectorAll('[data-current-project]').forEach(element => { element.textContent = projects.find(project => project.id === active)?.name || '个人空间'; });
}

export async function activateProject(id, { notify = true } = {}) {
  if (changing) { syncProjectChrome(); return; }
  if (!projects.some(project => project.id === id)) id = 'default';
  const previous = active;
  changing = true; syncProjectChrome();
  try {
    active = id;
    if (notify && previous !== id) await switchProject?.(id);
    localStorage.setItem(ACTIVE_KEY, active);
  } catch(error) { active = previous; throw error;
  } finally { changing = false; syncProjectChrome(); }
}

export async function mountProjectWorkspace(onSwitch) {
  switchProject = onSwitch;
  projects = await projectRequest('projects');
  if (!projects.some(project => project.id === active)) active = 'default';
  syncProjectChrome();
}

export function openProjectSettings() { openSettingsSheet({ section: 'projects' }); }
export function openSkillsSettings() { openSettingsSheet({ section: 'skills' }); }
export function projectList() { return projects.map(project => ({ ...project })); }

export function openProjectCreateDialog() {
  const modal = document.getElementById('project-create-modal');
  if (!modal) return;
  const name = modal.querySelector('[data-project-name]');
  const roots = modal.querySelector('[data-project-roots]');
  const status = modal.querySelector('[data-project-create-status]');
  modal.hidden = false; modal.removeAttribute('aria-hidden'); status.textContent = '';
  roots.value = ''; name.value = ''; name.focus();
  const close = () => { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); };
  modal.querySelector('[data-project-close]').onclick = close;
  modal.querySelector('[data-project-cancel]').onclick = close;
  modal.querySelector('[data-project-pick]').onclick = async () => {
    try { const result = await projectRequest('select-directory', { method: 'POST', body: '{}' }); if (result.directory) roots.value = [roots.value.trim(), result.directory].filter(Boolean).join('\n'); }
    catch (error) { status.textContent = error.message; }
  };
  modal.querySelector('[data-project-create]').onclick = async () => {
    const button = modal.querySelector('[data-project-create]'); button.disabled = true;
    try {
      const project = await projectRequest('projects', { method: 'POST', body: JSON.stringify({ name: name.value, roots: roots.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) });
      projects = await projectRequest('projects'); await activateProject(project.id); close();
    } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
  };
}

export function mountProjectSettings(host) {
  host.innerHTML = `<div class="workspace-settings project-settings">
    <p class="settings-sheet-sub">当前项目 · <strong data-current-project></strong></p>
    <label>项目名称<input class="settings-text-input" data-name maxlength="120"></label>
    <label>本地目录<textarea class="settings-textarea" data-roots rows="4" placeholder="每行一个目录"></textarea><small>模型只读取这些目录，目录中的文件不会被修改。</small></label>
    <div class="project-actions"><button class="settings-button" data-pick>添加目录</button><button class="settings-button" data-save>保存项目</button><button class="settings-button settings-button-quiet" data-delete>删除项目</button></div>
    <div data-pinned></div>
    <div class="workspace-divider"></div><label>新建项目<input class="settings-text-input" data-new placeholder="项目名称" maxlength="120"></label><button class="settings-button" data-create>创建并切换</button>
    <div class="workspace-divider"></div><label>项目文件<input class="settings-text-input" data-search placeholder="搜索文件名或内容"></label><div class="project-actions"><button class="settings-button" data-browse>浏览目录</button><button class="settings-button" data-find>搜索</button></div><div data-files class="workspace-files"></div><pre data-content class="workspace-file-content" hidden></pre>
    <div class="workspace-divider"></div><label>Canvas 保存目录<input class="settings-text-input" data-library></label><small>显示实际保存位置。更换后重新载入资料库，原目录中的内容继续保留。</small><div class="project-actions"><button class="settings-button" data-pick-library>选择目录</button><button class="settings-button" data-save-library>保存并重新载入</button></div><p role="status" data-status></p></div>`;
  const find = selector => host.querySelector(selector);
  const run = operation => async () => { try { await operation(); } catch(error) { find('[data-status]').textContent = error.message; } };
  const current = () => projects.find(project => project.id === active);
  const refresh = async () => {
    projects = await projectRequest('projects'); syncProjectChrome();
    find('[data-name]').value = current()?.name || '';
    find('[data-roots]').value = current()?.roots.join('\n') || '';
    const sources = current()?.context_sources || [];
    find('[data-pinned]').innerHTML = sources.length ? '<p>每次提问都会读取以下资料的当前内容：</p><ul>' + sources.map(source => `<li>${escapeHtml(source.path)}${source.heading ? ` · ${escapeHtml(source.heading)}` : ''}（${source.role === 'guidance' ? '交流约定' : '项目资料'}）</li>`).join('') + '</ul>' : '';
    find('[data-delete]').disabled = active === 'default';
    find('[data-library]').value = (await projectRequest('config')).directory;
  };
  const pick = async input => { const result = await projectRequest('select-directory', { method: 'POST', body: '{}' }); if (result.directory) input.value = result.directory; };
  find('[data-pick]').onclick = run(async () => { const value = { value: '' }; await pick(value); if (value.value) find('[data-roots]').value = [find('[data-roots]').value.trim(), value.value].filter(Boolean).join('\n'); });
  find('[data-save]').onclick = run(async () => {
    await projectRequest(`projects/${active}`, { method: 'PUT', body: JSON.stringify({ name: find('[data-name]').value, roots: find('[data-roots]').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) });
    await refresh(); find('[data-status]').textContent = '项目已保存，下次提问立即使用当前目录。';
  });
  find('[data-create]').onclick = run(async () => {
    const project = await projectRequest('projects', { method: 'POST', body: JSON.stringify({ name: find('[data-new]').value, roots: [] }) });
    projects = await projectRequest('projects'); await activateProject(project.id); await refresh(); find('[data-new]').value = ''; find('[data-status]').textContent = '已切换到新项目，可以添加本地目录。';
  });
  find('[data-delete]').onclick = run(async () => {
    if (!window.confirm('删除这个项目？其中的 Rabbitholes 将保留在个人空间，本地目录不会被修改。')) return;
    const id = active; await activateProject('default'); await projectRequest(`projects/${id}`, { method: 'DELETE' }); await refresh(); await switchProject?.('default');
  });
  const showFiles = async (query, location = null) => {
    const id = active;
    const result = await projectRequest(`projects/${id}/${query ? `search?q=${encodeURIComponent(query)}` : `tree?depth=0&limit=500${location ? `&root=${location.root}&path=${encodeURIComponent(location.path)}` : ''}`}`);
    if (active !== id) return;
    const rows = result.results || result.entries;
    find('[data-files]').replaceChildren();
    find('[data-content]').hidden = true;
    if (location?.path) { const back = document.createElement('button'); back.textContent = '← 返回上级'; back.onclick = run(() => { const parent = location.path.split('/').slice(0,-1).join('/'); return showFiles('', parent ? { ...location, path: parent } : null); }); find('[data-files]').append(back); }
    for (const row of rows) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `${row.root + 1} / ${row.path}${row.type === 'directory' ? '/' : ''}`;
      button.onclick = run(async () => { if(row.type==='directory')return showFiles('',row);const file = await projectRequest(`projects/${id}/read?root=${row.root}&path=${encodeURIComponent(row.path)}`); if(active!==id)return;find('[data-content]').hidden = false; find('[data-content]').textContent = file.content; });
      find('[data-files]').append(button);
    }
    find('[data-status]').textContent = result.truncated ? '已展示部分文件，可输入名称缩小范围。' : `找到 ${rows.length} 项`;
  };
  find('[data-browse]').onclick = run(() => showFiles(''));
  find('[data-find]').onclick = run(() => showFiles(find('[data-search]').value.trim()));
  find('[data-pick-library]').onclick = run(() => pick(find('[data-library]')));
  find('[data-save-library]').onclick = run(async () => { await window.dailyDeskFlushReading?.(); await projectRequest('config', { method: 'POST', body: JSON.stringify({ directory: find('[data-library]').value }) }); location.assign('/'); });
  void refresh().catch(error => { find('[data-status]').textContent = error.message; });
  return () => {};
}

function mountSkills(host) {
  host.innerHTML = '<div class="workspace-skills project-settings"><p>当前项目 · <strong data-current-project></strong></p><p class="settings-sheet-sub">“跟随全局”使用全局开关；项目设置可独立开启或关闭。修改后下一次提问即生效。</p><div data-skills></div><p role="status" data-status></p></div>';
  const render = async () => {
    projects = await projectRequest('projects'); syncProjectChrome();
    const rows = await projectRequest(`skills?project_id=${active}`);
    host.querySelector('[data-skills]').innerHTML = rows.map(skill => `<article class="workspace-skill" data-id="${escapeHtml(skill.id)}"><strong>${escapeHtml(skill.name)}</strong><p>${escapeHtml(skill.description)}</p><small>${escapeHtml(skill.source)}</small><div class="project-actions"><label><input type="checkbox" data-global ${skill.global_enabled ? 'checked' : ''}> 全局启用</label><select data-override aria-label="${escapeHtml(skill.name)} 项目状态"><option value="inherit" ${skill.override === null ? 'selected' : ''}>跟随全局</option><option value="true" ${skill.override === true ? 'selected' : ''}>项目开启</option><option value="false" ${skill.override === false ? 'selected' : ''}>项目关闭</option></select><span>${skill.enabled ? '当前生效' : '当前关闭'}</span></div></article>`).join('') || '<p>当前项目尚未发现 Skills。可在授权目录的 .agents/skills 或 .claude/skills 中放置 SKILL.md。</p>';
  };
  let saving = false;
  host.onchange = async event => {
    const row = event.target.closest('[data-id]'); if (!row) return;
    if (saving) return;
    saving = true;
    host.querySelectorAll('input,select').forEach(control => { control.disabled = true; });
    try {
      if (event.target.matches('[data-global]')) await projectRequest('skills', { method: 'PUT', body: JSON.stringify({ [row.dataset.id]: event.target.checked }) });
      else { const project = projects.find(project => project.id === active); const skills = { ...project.skills }; if (event.target.value === 'inherit') delete skills[row.dataset.id]; else skills[row.dataset.id] = event.target.value === 'true'; await projectRequest(`projects/${active}`, { method: 'PUT', body: JSON.stringify({ skills }) }); }
      await render(); host.querySelector('[data-status]').textContent = '已保存。正在生成的回答沿用发起时的配置。';
    } catch(error) { host.querySelector('[data-status]').textContent = error.message; }
    finally { saving = false; host.querySelectorAll('input,select').forEach(control => { control.disabled = false; }); }
  };
  void render().catch(error => { host.querySelector('[data-status]').textContent = error.message; });
  return () => { host.onchange = null; };
}

export const projectSettingsSection = () => ({ id: 'projects', label: '项目与文件', order: 12, mount: mountProjectSettings });
export const skillsSettingsSection = () => ({ id: 'skills', label: 'Skills', order: 13, mount: mountSkills });
