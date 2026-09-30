import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parsePersistedHole, toPersistedHole } from '../../packages/rabbithole/src/core/schema.js';
import { rankedExcerpts, textSections } from '../../packages/rabbithole/src/core/context-excerpts.js';

const TEXT_FILE_LIMIT = 16 * 1024 * 1024;
const indexedText = entry => entry.type === 'file' && /\.(md|txt|py|js|mjs|cjs|ts|tsx|jsx|cpp|h|hpp|c|cu|glsl|yaml|yml|toml|json|csv|sh|ps1)$/i.test(entry.path) && !/(^|\/)(\.env(?:\.|$)|.*\.(pem|key)$)/i.test(entry.path);
const skippedDirectory = name => ['.git', 'node_modules', '.dailydesk', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist', '.cache'].includes(name) || name.startsWith('待删除_');
const bulkDirectory = name => ['data', 'datasets', 'checkpoints', 'weights', 'artifacts', 'logs', '训练数据', '模型权重'].includes(name.toLowerCase());
const sourceDirectory = name => ['src', 'source', 'scripts', 'configs', 'forgetsr_src'].includes(name);

const digest = (text) => createHash('sha256').update(text).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const copy = (value) => structuredClone(value);
const safeId = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value)) throw new LibraryError('文件标识无效。', 400);
  return value;
};
export class LibraryError extends Error {
  constructor(message, status = 409, details = {}) { super(message); this.status = status; this.details = details; }
}
function validateHole(value) {
  if (value?.schema_version > 2) throw new LibraryError('文件版本较新，需要更新程序后打开。', 400);
  const hole = toPersistedHole(value);
  safeId(hole.hole_id);
  if (!hole.nodes.length || hole.nodes.length > 10000) throw new LibraryError('画布节点数量无效。', 400);
  const nodes = new Map(); const fileNames = new Set();
  for (const node of hole.nodes) {
    safeId(node.id);
    if (nodes.has(node.id) || fileNames.has(node.id.toLowerCase())) throw new LibraryError('画布含有重复节点。', 400);
    fileNames.add(node.id.toLowerCase());
    nodes.set(node.id, node);
  }
  if (!nodes.has(hole.root_id)) throw new LibraryError('画布缺少根文档。', 400);
  for (const node of hole.nodes) {
    const seen = new Set([node.id]);
    let id = node.parent_id;
    while (id) {
      if (!nodes.has(id) || seen.has(id)) throw new LibraryError('分支关系含有循环或缺少父节点。', 400);
      seen.add(id); id = nodes.get(id).parent_id;
    }
  }
  return hole;
}
// Only Markdown link destinations are rewritten; code samples remain untouched.
function assetLinks(markdown, id, relative, toDisk) {
  let fence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.replace(/(\]\(<?)([^\s)>]+)(>?[^)]*\))/g, (all, before, url, after) => {
      if (toDisk && /^asset:[A-Za-z0-9._-]+$/.test(url)) return before + path.posix.relative(path.posix.dirname(relative), `${id}/assets/${url.slice(6)}`) + after;
      if (!toDisk && !/^[a-z]+:/i.test(url)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), url));
        if (resolved.startsWith(`${id}/assets/`)) return before + 'asset:' + path.posix.basename(resolved) + after;
      }
      return all;
    });
  }).join('\n');
}
function bodyFingerprint(node) {
  return digest(json({ markdown: node.markdown, title: node.title, origin: node.origin, status: node.status, paused: node.extensions?.dailydesk?.paused || false, generation: node.extensions?.dailydesk?.generation || null }));
}
function citations(hole, previous = {}) {
  const result = {};
  for (const node of hole.nodes) {
    const quote = node.origin?.selected_text;
    const parent = hole.nodes.find((n) => n.id === node.parent_id);
    if (!quote || !parent) continue;
    const first = parent.markdown.indexOf(quote);
    const repeated = first >= 0 && parent.markdown.indexOf(quote, first + quote.length) >= 0;
    const prior = previous[node.id]?.quote === quote && previous[node.id]?.parent_id === parent.id ? previous[node.id] : null;
    result[node.id] = {
      quote, parent_id: parent.id, original_anchor: prior?.original_anchor || node.origin.anchor,
      source_hash: prior?.source_hash || digest(parent.markdown),
      source_markdown: prior?.source_markdown ?? parent.markdown,
      current_source_hash: digest(parent.markdown),
      state: first < 0 ? 'needs-review' : repeated ? 'ambiguous' : 'located',
      markdown_offset: first < 0 || repeated ? null : first,
    };
  }
  return result;
}

export class ReadingLibrary {
  constructor(root, { fault, configFile = null, skillDirectory = null } = {}) { this.root = path.resolve(root); this.queues = new Map(); this.fault = fault; this.projects = []; this.configFile=configFile; this.workspaceRoot=this.root; this.skillDirectory=skillDirectory; }
  async init() {
    if(this.configFile){try{this.root=JSON.parse(await fs.readFile(this.configFile,'utf8')).directory||this.root;}catch(error){if(error.code!=='ENOENT')throw error;}}
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
    await fs.mkdir(path.join(this.root, '.dailydesk'), { recursive: true });
    await this.loadProjects();
    if(!this.projects.some(project=>project.id==='default')){this.projects.unshift({id:'default',name:'个人空间',roots:[],skills:{}});await this.saveProjects();}
    return this;
  }
  async setRoot(root) {
    if (typeof root !== 'string' || !root.trim()) throw new LibraryError('资料库目录不能为空。', 400);
    const requested = path.resolve(root.trim());
    await fs.mkdir(requested, { recursive: true });
    await Promise.all([...this.queues.values()]);
    const resolved = await fs.realpath(requested);
    if(this.configFile){await fs.mkdir(path.dirname(this.configFile),{recursive:true});const temporary=this.configFile+'.tmp';await fs.writeFile(temporary,json({directory:resolved}));await fs.rename(temporary,this.configFile);}
    this.root = resolved;
    await fs.mkdir(path.join(this.root, '.dailydesk'), { recursive: true });
    return this.root;
  }
  async loadProjects() {
    await fs.mkdir(path.join(this.workspaceRoot,'.dailydesk'),{recursive:true});
    const raw = await fs.readFile(path.join(this.workspaceRoot,'.dailydesk/projects.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if (!raw) { this.projects = []; return this.projects; }
    try {
      const parsed = JSON.parse(raw);
      this.projects = Array.isArray(parsed) ? parsed.filter((project) => project && typeof project.id === 'string' && typeof project.name === 'string' && Array.isArray(project.roots)) : [];
    } catch { throw new LibraryError('项目配置无法解析。', 500); }
    return this.projects;
  }
  async saveProjects() { const target=path.join(this.workspaceRoot,'.dailydesk/projects.json');const temporary=target+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,json(this.projects));await fs.rename(temporary,target); }
  projectSummary(project) { return { id: project.id, name: project.name, roots: [...project.roots], skills: project.skills||{}, context_sources: project.context_sources || [], created_at: project.created_at, updated_at: project.updated_at }; }
  async listProjects() { await this.loadProjects(); return this.projects.map((project) => this.projectSummary(project)); }
  async createProject({ name, roots }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName || normalizedName.length > 120) throw new LibraryError('项目名称无效。', 400);
    if (!Array.isArray(roots) || roots.length > 16) throw new LibraryError('项目目录数量无效。', 400);
    const resolvedRoots = await this.validateProjectRoots(roots);
    const now = new Date().toISOString();
    const project = { id: `project-${randomUUID()}`, name: normalizedName, roots: resolvedRoots, created_at: now, updated_at: now };
    this.projects.push(project); await this.saveProjects(); return this.projectSummary(project);
  }
  async updateProject(id, { name, roots, skills, context_sources }) {
    const project = this.projects.find((entry) => entry.id === id);
    if (!project) throw new LibraryError('项目不存在。', 404);
    const next={...project};
    if (name !== undefined) { const normalizedName = String(name).trim(); if (!normalizedName || normalizedName.length > 120) throw new LibraryError('项目名称无效。', 400); next.name = normalizedName; }
    if (roots !== undefined) next.roots = await this.validateProjectRoots(roots);
    if(skills!==undefined){if(!skills||typeof skills!=='object'||Array.isArray(skills)||Object.values(skills).some(value=>typeof value!=='boolean'))throw new LibraryError('Skill 配置无效。',400);next.skills={...skills};}
    if (context_sources !== undefined) {
      if (!Array.isArray(context_sources) || context_sources.length > 16) throw new LibraryError('固定资料配置无效。', 400);
      next.context_sources = context_sources.map(source => {
        if (!source || !Number.isInteger(source.root) || !next.roots[source.root] || !['reference', 'guidance'].includes(source.role) || (source.heading !== undefined && typeof source.heading !== 'string')) throw new LibraryError('固定资料位置无效。', 400);
        this.validateProjectRelative(source.path);
        return { root: source.root, path: source.path, heading: source.heading || '', role: source.role };
      });
    } else if (roots !== undefined) {
      next.context_sources = (project.context_sources || []).map(source => {
        const root = next.roots.indexOf(project.roots[source.root]);
        if (root < 0) throw new LibraryError('目录中包含固定资料，请同时更新固定资料配置。', 400);
        return { ...source, root };
      });
    }
    Object.assign(project,next);
    project.updated_at = new Date().toISOString(); await this.saveProjects(); return this.projectSummary(project);
  }
  async deleteProject(id) {
    if(id==='default')throw new LibraryError('个人空间用于保留未分类资料，不能删除。',400);
    const index = this.projects.findIndex((entry) => entry.id === id);
    if (index < 0) throw new LibraryError('项目不存在。', 404);
    for(const row of await this.list())if(row.project_id===id){const envelope=await this.load(row.hole_id);const root=envelope.hole.nodes.find(node=>node.id===envelope.hole.root_id);root.extensions.dailydesk={...root.extensions.dailydesk,project_id:'default'};await this.save(envelope.hole,envelope.revision,'project-removed');}
    this.projects.splice(index, 1); await this.saveProjects(); return { deleted: true, id };
  }
  async skillCatalog(projectId='default') {
    const project=this.getProject(projectId);const catalog=[];
    const add=async(id,file,source)=>{const content=await fs.readFile(file,'utf8');if(content.length>100000)return;const front=content.match(/^---\r?\n([\s\S]*?)\r?\n---/);const fields=front?.[1]||'';const field=name=>fields.match(new RegExp(`^${name}:\\s*(.+)$`,'m'))?.[1]?.replace(/^["']|["']$/g,'');catalog.push({id,name:field('name')||path.basename(path.dirname(file)),description:field('description')||'项目阅读辅助指令',source,content});};
    if (this.skillDirectory) {
      await add('jianran-learning', path.join(this.skillDirectory, 'SKILL.md'), 'DailyDesk 内置');
      const style = await fs.readFile(path.join(this.skillDirectory, 'references/TEACHING_STYLE.md'), 'utf8');
      catalog[0].content += '\n\n--- references/TEACHING_STYLE.md ---\n' + style;
      catalog[0].content += '\n\nDailyDesk 当前请求已附上教学表达规则。课程理解与进度以当前问答和附上的项目交流记录为依据。项目工具提供只读查询；文件保存由应用负责。';
    }
    for(let rootIndex=0;rootIndex<project.roots.length;rootIndex++)for(const base of ['.agents/skills','.claude/skills']){
      try{const directory=await this.resolveProjectPath(project,project.roots[rootIndex],base);for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;try{const file=await this.resolveProjectPath(project,project.roots[rootIndex],`${base}/${entry.name}/SKILL.md`);const identity=`local:${digest(process.platform==='win32'?file.toLowerCase():file)}`;if(!catalog.some(skill=>skill.id===identity))await add(identity,file,`${project.roots[rootIndex]}/${base}`);}catch(error){if(!['ENOENT','EACCES'].includes(error.code)&&!(error instanceof LibraryError))throw error;}}}catch(error){if(!['ENOENT','EACCES'].includes(error.code)&&!(error instanceof LibraryError))throw error;}
    }
    let global={};try{global=JSON.parse(await fs.readFile(path.join(this.workspaceRoot,'.dailydesk/skills.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    return catalog.map(skill=>({...skill,global_enabled:global[skill.id]??true,override:project.skills?.[skill.id]??null,enabled:project.skills?.[skill.id]??global[skill.id]??true}));
  }
  async configureSkills(values) {
    if(!values||typeof values!=='object'||Array.isArray(values)||Object.values(values).some(value=>typeof value!=='boolean'))throw new LibraryError('Skill 配置无效。',400);
    const target=path.join(this.workspaceRoot,'.dailydesk/skills.json');let previous={};try{previous=JSON.parse(await fs.readFile(target,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=target+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,json({...previous,...values}));await fs.rename(temporary,target);return {saved:true};
  }
  async validateProjectRoots(roots) {
    if(!Array.isArray(roots)||roots.length>16)throw new LibraryError('项目目录数量无效。',400);
    const output = []; const seen = new Set();
    for (const raw of roots) {
      if (typeof raw !== 'string' || !raw.trim()) throw new LibraryError('项目目录无效。', 400);
      const requested = path.resolve(raw.trim());
      let resolved;
      try { resolved = await fs.realpath(requested); } catch (error) { throw new LibraryError(`项目目录无法访问：${raw}`, 400, { code: error.code }); }
      const stat = await fs.stat(resolved); if (!stat.isDirectory()) throw new LibraryError(`项目路径不是目录：${raw}`, 400);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (!seen.has(key)) { seen.add(key); output.push(resolved); }
    }
    return output;
  }
  getProject(id) { const project = this.projects.find((entry) => entry.id === id); if (!project) throw new LibraryError('项目不存在。', 404); return project; }
  validateProjectRelative(relative = '') {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.includes(':')) throw new LibraryError('项目文件路径无效。', 400);
    const segments = relative.split('/').filter(Boolean);
    if (segments.some((part) => part === '..' || part === '.' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) throw new LibraryError('项目文件路径越界。', 400);
    return segments;
  }
  async resolveProjectPath(project, root, relative = '') {
    if((await fs.lstat(root)).isSymbolicLink()||path.relative(root,await fs.realpath(root))!=='')throw new LibraryError('授权根目录已变更，请重新选择。',403);
    const segments = this.validateProjectRelative(relative);
    const target = path.resolve(root, ...segments);
    const inside = path.relative(root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new LibraryError('项目文件路径越界。', 400);
    let cursor = root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new LibraryError('项目目录中的符号链接不允许访问。', 403);
        const resolved = await fs.realpath(cursor); const resolvedInside = path.relative(root, resolved);
        if (resolvedInside.startsWith('..') || path.isAbsolute(resolvedInside)) throw new LibraryError('项目目录中的重解析点不允许越出授权范围。', 403);
      }
      catch (error) { if (error instanceof LibraryError) throw error; if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async projectEntries(id, relative = '', { depth = 4, limit = 500, rootIndex: selectedRoot = null, indexing = false } = {}) {
    const project = this.getProject(id); const rows = []; const safeDepth = Math.max(0, Math.min(8, Number(depth) || 0)); const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
    const roots = project.roots;
    let truncated = false;
    if(selectedRoot!==null&&(!Number.isInteger(Number(selectedRoot))||!roots[Number(selectedRoot)]))throw new LibraryError('项目目录无效。',400);
    for (let rootIndex = 0; rootIndex < roots.length && rows.length < safeLimit; rootIndex++) {
      if(selectedRoot!==null&&rootIndex!==Number(selectedRoot))continue;
      const rootLimit = selectedRoot === null ? Math.min(safeLimit, rows.length + Math.max(1, Math.floor((safeLimit - rows.length) / (roots.length - rootIndex)))) : safeLimit;
      const root = roots[rootIndex]; const target = await this.resolveProjectPath(project, root, relative);
      const walk = async (directory, currentDepth) => {
        if (rows.length >= rootLimit) { truncated = true; return; }
        let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        entries.sort((first, second) => (indexing ? Number(sourceDirectory(second.name)) - Number(sourceDirectory(first.name)) : 0) || first.name.localeCompare(second.name, undefined, { sensitivity: 'base' }));
        for (const entry of entries) {
          if (skippedDirectory(entry.name) || (indexing && entry.isDirectory() && bulkDirectory(entry.name))) continue;
          if (rows.length >= rootLimit) { truncated = true; break; }
          if(entry.isSymbolicLink())continue;
          const childRelative = path.relative(root,path.join(directory,entry.name)).split(path.sep).join('/');
          const child = await this.resolveProjectPath(project, root, childRelative);
          const isDirectory = entry.isDirectory();
          rows.push({ root: rootIndex, path: childRelative, name: entry.name, type: isDirectory ? 'directory' : 'file' });
          if (isDirectory && currentDepth < safeDepth) await walk(child, currentDepth + 1);
        }
      };
      const stat = await fs.stat(target); if (stat.isDirectory()) await walk(target, 0); else rows.push({ root: rootIndex, path: relative, name: path.basename(target), type: 'file' });
    }
    return { project: this.projectSummary(project), relative, entries: rows, truncated: truncated || rows.length >= safeLimit };
  }
  async readProjectFile(id, relative, { maxBytes = TEXT_FILE_LIMIT, rootIndex = null, offset = 0, length = null } = {}) {
    const project = this.getProject(id); const segments = this.validateProjectRelative(relative); if (!segments.length) throw new LibraryError('需要指定文件路径。', 400);
    let file = null;
    const roots=rootIndex===null?project.roots:[project.roots[Number(rootIndex)]];if(roots.some(root=>!root))throw new LibraryError('项目目录无效。',400);
    for (const root of roots) { const candidate = await this.resolveProjectPath(project, root, relative); try { const stat = await fs.stat(candidate); if (stat.isFile()) { file = candidate; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (!file) throw new LibraryError('项目文件不存在。', 404);
    const stat = await fs.stat(file); if (stat.size > Math.min(TEXT_FILE_LIMIT, maxBytes)) throw new LibraryError('项目文件超过可读取大小限制（16 MB）。', 413, { size: stat.size });
    const buffer = await fs.readFile(file);
    const encoding = buffer[0] === 255 && buffer[1] === 254 ? 'utf-16le' : buffer[0] === 254 && buffer[1] === 255 ? 'utf-16be' : 'utf-8';
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { throw new LibraryError('项目文件文本编码无法识别，请使用 UTF-8 或带 BOM 的 UTF-16。', 415); }
    const controls = text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || [];
    if (controls.length > text.length * 0.01) throw new LibraryError('二进制文件不提供文本读取。', 415);
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, character => String.fromCharCode(0x2400 + character.charCodeAt(0)));
    let start = Math.max(0, Math.min(text.length, Math.floor(Number(offset) || 0)));
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] || '')) start--;
    let end = length === null ? text.length : Math.min(text.length, start + Math.max(1, Math.min(20000, Math.floor(Number(length) || 20000))));
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    return { project: this.projectSummary(project), path: relative, root: project.roots.findIndex(root => file === path.resolve(root, ...segments)), content: text.slice(start, end), bytes: buffer.length, total_chars: text.length, offset: start, next_offset: end < text.length ? end : null, line_start: text.slice(0, start).split('\n').length, escaped_controls: controls.length };
  }
  async searchProject(id, query, { limit = 100 } = {}) {
    const needle = String(query || '').trim(); if (!needle) return { project: this.projectSummary(this.getProject(id)), query: '', results: [] };
    const scanned = await this.projectExcerpts(id, needle);
    const results = scanned.candidates.sort((first, second) => second.score - first.score).slice(0, Math.max(1, Math.min(200, Number(limit) || 100))).map(({ content, ...entry }) => ({ ...entry, preview: content }));
    return { project: this.projectSummary(this.getProject(id)), query: needle, results, truncated: scanned.truncated || results.length < scanned.candidates.length, skipped: scanned.skipped };
  }
  async projectExcerpts(id, query) {
    const tree = await this.projectEntries(id, '', { depth: 8, limit: 2000, indexing: true });
    const entries = tree.entries.filter(indexedText);
    for (const source of this.getProject(id).context_sources || []) {
      if (!entries.some(entry => entry.root === source.root && entry.path === source.path)) entries.unshift({ ...source, type: 'file' });
    }
    const candidates = [];
    const skipped = [];
    for (const entry of entries) {
      try {
        const file = await this.readProjectFile(id, entry.path, { rootIndex: entry.root });
        for (const excerpt of rankedExcerpts(file.content, query, { path: entry.path }).slice(0, 12)) candidates.push({ ...excerpt, root: entry.root, path: entry.path });
      } catch (error) { skipped.push({ root: entry.root, path: entry.path, reason: error.message }); }
    }
    return { candidates, skipped, truncated: tree.truncated };
  }
  async pinnedProjectContext(id) {
    const project = this.getProject(id);
    const pinned = [];
    for (const source of project.context_sources || []) {
      const file = await this.readProjectFile(id, source.path, { rootIndex: source.root });
      const section = source.heading ? textSections(file.content).find(section => section.heading === source.heading) : { offset: 0, end: file.content.length, line_start: 1 };
      if (!section) throw new LibraryError(`固定资料章节未找到：${source.path} / ${source.heading}`, 409);
      const content = file.content.slice(section.offset, section.end);
      pinned.push({ ...source, project_id: id, project_name: project.name, content, offset: section.offset, line_start: section.line_start });
    }
    if (pinned.reduce((total, source) => total + source.content.length, 0) > 32000) throw new LibraryError('固定资料超过 32000 字符，请在项目设置中指定较短的章节。', 413);
    return pinned;
  }
  async projectContext(ids, query = '', { charBudget = 120000 } = {}) {
    const requested = Array.isArray(ids) ? [...new Set(ids)].slice(0, 16) : [];
    const candidates = [], pinned = [], skipped = [];
    let treeTruncated = false;
    charBudget = Math.max(0, Math.min(24000, Number(charBudget) || 24000));
    for (const id of requested.slice(0, 16)) {
      const project = this.getProject(id);
      pinned.push(...await this.pinnedProjectContext(id));
      const scanned = await this.projectExcerpts(id, query);
      treeTruncated ||= scanned.truncated;
      skipped.push(...scanned.skipped.map(entry => ({ project_id: id, ...entry })));
      candidates.push(...scanned.candidates.map(entry => ({ project_id: id, project_name: project.name, ...entry })));
    }
    if (pinned.reduce((total, source) => total + source.content.length, 0) > 32000) throw new LibraryError('所选项目的固定资料合计超过 32000 字符。', 413);
    candidates.sort((first, second) => second.score - first.score || first.root - second.root || first.path.localeCompare(second.path));
    const files = []; let used = 0;
    for (const candidate of candidates) {
      if (used + candidate.content.length > charBudget) continue;
      if (files.some(file => file.project_id === candidate.project_id && file.root === candidate.root && file.path === candidate.path && Math.abs(file.offset - candidate.offset) < 1550)) continue;
      files.push(candidate); used += candidate.content.length;
    }
    const skills=requested.length?await this.skillCatalog(requested[0]):[];
    return { projects: requested.map(id => this.projectSummary(this.getProject(id))), files, pinned, skipped, skills:skills.filter(skill=>skill.enabled).map(({id,name,content})=>({id,name,content:content.slice(0,24000)})), learning_enabled:skills.some(skill=>skill.id==='jianran-learning'&&skill.enabled), truncated: treeTruncated || files.length < candidates.length || skipped.length > 0, query: String(query || '') };
  }
  async file(relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative)) throw new LibraryError('文件路径无效。', 400);
    const segments = relative.split('/');
    if (segments.some((part) => !part || part === '..' || part === '.' || /[<>"|?*]/.test(part) || /[. ]$/.test(part))) throw new LibraryError('文件路径越界。', 400);
    const target = path.resolve(this.root, ...segments);
    const inside = path.relative(this.root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new LibraryError('文件路径越界。', 400);
    let cursor = this.root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new LibraryError('资料库中的链接路径需要先处理。', 400); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async text(relative) { try { return await fs.readFile(await this.file(relative), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async atomic(relative, content) {
    const target = await this.file(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temp, target); } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }
  meta(id, name) { return `.dailydesk/${safeId(id)}/${name}`; }
  serial(id, fn, { recover = true } = {}) {
    safeId(id);
    const next = (this.queues.get(id) || Promise.resolve()).then(async () => {
      const lock = await this.file(this.meta(id, 'write.lock'));
      await fs.mkdir(path.dirname(lock), { recursive: true });
      let handle;
      try { handle = await fs.open(lock, 'wx'); await handle.writeFile(String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(lock, 'utf8'));
        let alive = true;
        if (owner > 0) { try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; } }
        if (alive) throw new LibraryError('另一个进程正在保存这张画布，请稍后重试。', 423);
        await fs.unlink(lock);
        handle = await fs.open(lock, 'wx'); await handle.writeFile(String(process.pid));
      }
      try { if (recover) await this.recover(id); return await fn(); }
      finally { await handle.close(); await fs.unlink(lock); }
    });
    this.queues.set(id, next.catch(() => {}));
    return next;
  }
  async recover(id) {
    const raw = await this.text(this.meta(id, 'pending.json'));
    if (!raw) return;
    const transaction = JSON.parse(raw);
    for (let i = 0; i < transaction.writes.length; i++) {
      const write = transaction.writes[i];
      const current = await this.text(write.path);
      if (current === write.content) continue;
      if ((current === null ? null : digest(current)) !== write.before) throw new LibraryError('保存中断后，文件又发生了修改。两份内容均已保留，请打开资料库处理。', 409, { interrupted: true, path: write.path });
      await this.atomic(write.path, write.content);
      await this.fault?.(i, write.path);
    }
    await fs.unlink(await this.file(this.meta(id, 'pending.json')));
  }
  async state(id) {
    const value = await this.text(this.meta(id, 'state.json')); if (!value) return null;
    const state = JSON.parse(value);
    if (state.format !== 'dailydesk-reading' || state.version !== 1) throw new LibraryError('资料库记录使用了不支持的版本，请更新程序后再打开。');
    parsePersistedHole(state.hole);
    return state;
  }
  async list() {
    const entries = await fs.readdir(await this.file('.dailydesk'), { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'conflicts') continue;
      const state = await this.state(entry.name);
      if (state && !state.deleted) rows.push({ hole_id: state.hole.hole_id, project_id:state.hole.nodes.find(node=>node.id===state.hole.root_id)?.extensions?.dailydesk?.project_id||'default', title: state.hole.title, updated_at: state.hole.updated_at, node_count: state.hole.nodes.length });
    }
    return rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  async importExternal(state) {
    const id = state.hole.hole_id;
    const canvasText = await this.text(`${id}.canvas`);
    if (canvasText === null) throw new LibraryError('画布文件已被移动或删除，已有记录仍在资料库中。', 409);
    let canvas;
    try { canvas = JSON.parse(canvasText.replace(/^\uFEFF/, '')); } catch { throw new LibraryError('画布文件暂时无法解析，请完成文件编辑后重试。', 409); }
    if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) throw new LibraryError('画布缺少 nodes 或 edges。', 409);
    const hole = copy(state.hole); const files = { ...state.files }; let changed = digest(canvasText) !== state.hashes[`${id}.canvas`];
    const editable = canvas.nodes.filter((n) => n.type === 'text' || n.type === 'file' && String(n.file).toLowerCase().endsWith('.md'));
    const byId = new Map(hole.nodes.map((n) => [n.id, n])); const nextNodes = []; const referencedFiles = new Set();
    for (const item of editable) {
      safeId(item.id);
      if (item.type === 'file') {
        if (item.file.startsWith('.dailydesk/') || referencedFiles.has(item.file.toLowerCase())) throw new LibraryError('画布存在重复文档或引用了内部历史文件，请为节点使用独立的正文文件。');
        referencedFiles.add(item.file.toLowerCase());
      }
      if (![item.x, item.y, item.width, item.height].every(Number.isFinite) || item.width <= 0 || item.height <= 0) throw new LibraryError('画布节点尺寸无效。');
      let node = byId.get(item.id);
      if (!node) node = toPersistedHole({ ...hole, nodes: [{ ...hole.nodes[0], id: item.id, parent_id: hole.root_id, origin: null, extensions: {}, title: item.text?.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) || path.basename(item.file || '文档', '.md'), markdown: '', position: { x: item.x, y: item.y }, status: 'answered' }] }).nodes[0];
      const rawBody = item.type === 'text' ? String(item.text || '') : await this.text(item.file);
      if (rawBody === null) throw new LibraryError('画布引用的 Markdown 文件不存在。请恢复文件或更新画布中的路径。', 409, { path: item.file });
      const body = item.type === 'text' ? rawBody : assetLinks(rawBody, id, item.file, false);
      if (body !== node.markdown) { node.markdown = body; node.status = 'answered'; node.extensions = { ...node.extensions, dailydesk: { ...node.extensions?.dailydesk, paused: false } }; changed = true; }
      if (item.type === 'file') files[node.id] = item.file;
      node.position = { x: item.x, y: item.y }; node.size = { w: item.width, h: item.height };
      nextNodes.push(node);
    }
    if (!nextNodes.some((n) => n.id === hole.root_id)) throw new LibraryError('根文档已从画布移除。请恢复根文档后再同步。');
    const ids = new Set(nextNodes.map((n) => n.id));
    for (const node of nextNodes) {
      if (node.id === hole.root_id) { node.parent_id = null; continue; }
      const parents = canvas.edges.filter((e) => e.toNode === node.id && ids.has(e.fromNode));
      if (parents.length > 1) throw new LibraryError('一个阅读分支在画布中连接了多个来源，请保留一条父级连接后再同步。');
      node.parent_id = parents[0]?.fromNode || null;
    }
    hole.nodes = nextNodes;
    if (!changed) return state;
    validateHole(hole);
    return this.commit(hole, state, { reason: 'external-edit', files, canvas });
  }
  async load(id) {
    return this.serial(id, async () => {
      let state = await this.state(id);
      if (!state || state.deleted) return null;
      state = await this.importExternal(state);
      return this.envelope(state);
    });
  }
  envelope(state) { return { hole: copy(state.hole), revision: state.revision, citations: state.citations, directory: this.root, canvas: `${state.hole.hole_id}.canvas` }; }
  async save(value, revision, reason = 'save') {
    const hole = validateHole(value);
    const rootNode=hole.nodes.find(node=>node.id===hole.root_id);
    if(rootNode.extensions?.dailydesk?.project_id&&!this.projects.some(project=>project.id===rootNode.extensions.dailydesk.project_id))rootNode.extensions.dailydesk.project_id='default';
    return this.serial(hole.hole_id, async () => {
      let state = await this.state(hole.hole_id);
      if (state && !state.deleted) state = await this.importExternal(state);
      if (state && !state.deleted && json({ ...state.hole, updated_at: '' }) === json({ ...hole, updated_at: '' })) return this.envelope(state);
      if ((state?.revision || 0) !== revision) {
        const conflict = randomUUID();
        await this.atomic(this.meta(hole.hole_id, `conflicts/${conflict}.json`), json({ saved_at: new Date().toISOString(), expected_revision: revision, actual_revision: state?.revision || 0, hole }));
        throw new LibraryError('磁盘上已有另一份更新。本页内容已保留，可以载入磁盘内容或另存副本。', 409, { conflict, revision: state?.revision });
      }
      const next = await this.commit(hole, state, { reason });
      return this.envelope(next);
    });
  }
  async commit(hole, previous, { reason, files = previous?.files || {}, canvas = previous?.canvas || {} } = {}) {
    const id = safeId(hole.hole_id); const revision = (previous?.revision || 0) + 1;
    const writes = []; const hashes = {}; const nextFiles = {}; const versions = copy(previous?.versions || {});
    const citationsValue = citations(hole, previous?.citations);
    const add = async (relative, content) => {
      const before = await this.text(relative);
      if (before !== content) writes.push({ path: relative, content, before: before === null ? null : digest(before) });
      hashes[relative] = digest(content);
    };
    for (const node of hole.nodes) {
      const relative = files[node.id] || `${id}/${node.id}.md`;
      await this.file(relative);
      nextFiles[node.id] = relative;
      const old = previous?.hole.nodes.find((n) => n.id === node.id);
      const changed = !old || bodyFingerprint(old) !== bodyFingerprint(node);
      const checkpoint = node.status === 'answered' || node.extensions?.dailydesk?.paused;
      // Save a pending body before regeneration clears it, and completed/edited bodies.
      const candidates = [];
      if (old?.markdown && changed && (old.status === 'answered' || node.markdown === '' || old.extensions?.dailydesk?.paused)) candidates.push({ node: old, reason: 'before-change' });
      if (changed && checkpoint) candidates.push({ node, reason: reason === 'save' ? (node.extensions?.dailydesk?.generation ? 'answer-or-edit' : 'edit') : reason });
      for (const candidate of candidates) {
        const fingerprint = bodyFingerprint(candidate.node);
        versions[node.id] ||= [];
        if (versions[node.id].at(-1)?.fingerprint === fingerprint) continue;
        const version = { id: randomUUID(), fingerprint, reason: candidate.reason, at: new Date().toISOString(), revision, title: candidate.node.title, generation: candidate.node.extensions?.dailydesk?.generation || null };
        versions[node.id].push(version);
        await add(this.meta(id, `versions/${node.id}/${version.id}.json`), json({ ...version, node: candidate.node, citation: (candidate.node === old ? previous?.citations?.[node.id] : citationsValue[node.id]) || null }));
        const versionPath = this.meta(id, `versions/${node.id}/${version.id}.md`);
        await add(versionPath, assetLinks(candidate.node.markdown, id, versionPath, true));
      }
      await add(relative, assetLinks(node.markdown, id, relative, true));
    }
    // Deleted nodes remain in history, with their original files kept recoverable.
    for (const old of previous?.hole.nodes || []) {
      if (hole.nodes.some((n) => n.id === old.id)) continue;
      versions[old.id] ||= [];
      if (!versions[old.id].some((v) => v.fingerprint === bodyFingerprint(old))) {
        const version = { id: randomUUID(), fingerprint: bodyFingerprint(old), reason: 'removed', at: new Date().toISOString(), revision, title: old.title };
        versions[old.id].push(version);
        await add(this.meta(id, `versions/${old.id}/${version.id}.json`), json({ ...version, node: old, citation: previous?.citations?.[old.id] || null }));
        const versionPath = this.meta(id, `versions/${old.id}/${version.id}.md`);
        await add(versionPath, assetLinks(old.markdown, id, versionPath, true));
      }
    }
    const managedIds = new Set([...(previous?.hole.nodes || []), ...hole.nodes].map((n) => n.id));
    const originalNodes = new Map((canvas.nodes || []).map((n) => [n.id, n]));
    const outputCanvas = { ...canvas, nodes: [
      ...(canvas.nodes || []).filter((n) => !managedIds.has(n.id)),
      ...hole.nodes.map((node) => ({ ...originalNodes.get(node.id), id: node.id, type: 'file', file: nextFiles[node.id], x: Math.round(node.position.x), y: Math.round(node.position.y), width: Math.round(node.size?.w || 480), height: Math.round(node.size?.h || 420) })),
    ], edges: [
      ...(canvas.edges || []).filter((e) => !managedIds.has(e.fromNode) || !managedIds.has(e.toNode)),
      ...hole.nodes.filter((n) => n.parent_id).map((node) => ({ fromSide: 'right', toSide: 'left', ...(canvas.edges || []).find((e) => e.fromNode === node.parent_id && e.toNode === node.id), id: `edge-${node.id}`, fromNode: node.parent_id, toNode: node.id, label: node.origin?.question || '' })),
    ] };
    for (const node of outputCanvas.nodes) if (node.type === 'file') delete node.text;
    await add(`${id}.canvas`, json(outputCanvas));
    const state = { format: 'dailydesk-reading', version: 1, revision, hole, files: nextFiles, hashes: { ...hashes }, canvas: outputCanvas, versions, citations: citationsValue, deleted: false };
    await add(this.meta(id, 'state.json'), json(state)); // Commit point is last.
    await this.atomic(this.meta(id, 'pending.json'), json({ revision, writes }));
    await this.recover(id);
    return state;
  }
  async history(id, nodeId) {
    safeId(nodeId);
    return this.serial(id, async () => {
      const state = await this.state(id);
      if (!state) throw new LibraryError('画布不存在。', 404);
      const nodes = state.hole.nodes.map((n) => ({ id: n.id, title: n.title }));
      for (const [id, entries] of Object.entries(state.versions)) if (!nodes.some((n) => n.id === id)) nodes.push({ id, title: `${entries.at(-1)?.title || id} · 已移除` });
      return { revision: state.revision, nodes, versions: [...(state.versions[nodeId] || [])].reverse(), citation: state.citations[nodeId] || null };
    });
  }
  async version(id, nodeId, versionId) {
    safeId(nodeId); safeId(versionId);
    const raw = await this.text(this.meta(id, `versions/${nodeId}/${versionId}.json`));
    if (!raw) throw new LibraryError('版本不存在。', 404);
    return JSON.parse(raw);
  }
  async restore(id, nodeId, versionId, revision) {
    const entry = await this.version(id, nodeId, versionId);
    const current = await this.load(id);
    if (!current) throw new LibraryError('画布不存在。', 404);
    const index = current.hole.nodes.findIndex((n) => n.id === nodeId);
    const node = index < 0 ? copy(entry.node) : current.hole.nodes[index];
    if (node.parent_id && !current.hole.nodes.some((n) => n.id === node.parent_id)) node.parent_id = null;
    const restored = { ...node, markdown: entry.node.markdown, title: entry.node.title, status: 'answered', extensions: { ...node.extensions, dailydesk: { ...node.extensions?.dailydesk, paused: false, restored_from: versionId, generation: entry.node.extensions?.dailydesk?.generation || null } } };
    if (index < 0) current.hole.nodes.push(restored); else current.hole.nodes[index] = restored;
    return this.save(current.hole, revision, 'restored');
  }
  async archive(id) {
    return this.serial(id, async () => {
      const state = await this.state(id); if (!state) return;
      state.deleted = true; state.revision++;
      await this.atomic(this.meta(id, 'state.json'), json(state));
      return { archived: true, revision: state.revision };
    });
  }
  async finishRecovery(id) {
    return this.serial(id, async () => {
    // Preserve both the transaction and externally edited files before explicitly finishing.
    const raw = await this.text(this.meta(id, 'pending.json'));
    if (!raw) { const state = await this.state(id); return state ? this.envelope(state) : null; }
    const transaction = JSON.parse(raw); const conflict = randomUUID();
    const external = [];
    for (const write of transaction.writes) {
      const current = await this.text(write.path);
      if (current !== write.content && (current === null ? null : digest(current)) !== write.before) {
        external.push({ path: write.path, content: current });
        write.before = current === null ? null : digest(current);
      }
    }
    await this.atomic(this.meta(id, `conflicts/${conflict}.json`), json({ transaction: JSON.parse(raw), external }));
    await this.atomic(this.meta(id, 'pending.json'), json(transaction));
    await this.recover(id);
    return this.envelope(await this.state(id));
    }, { recover: false });
  }
  async putAsset(id, name, buffer) {
    safeId(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name) || name.includes('..')) throw new LibraryError('附件文件名无效。', 400);
    const relative = `${id}/assets/${name}`;
    const target = await this.file(relative);
    let before;
    try { before = await fs.readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before && digest(before) === digest(buffer)) return;
    if (before) await this.atomic(this.meta(id, `asset-history/${digest(before)}-${name}`), before);
    await this.atomic(relative, buffer);
  }
  async getAsset(id, name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name) || name.includes('..')) throw new LibraryError('附件文件名无效。', 400);
    try { return await fs.readFile(await this.file(`${safeId(id)}/assets/${name}`)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async assets(id) {
    try { return (await fs.readdir(await this.file(`${safeId(id)}/assets`))).filter((n) => !n.endsWith('.tmp')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
