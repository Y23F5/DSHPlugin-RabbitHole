import { spawn } from 'node:child_process';
import { LibraryError } from './reading-library.mjs';

function chooseDirectory() {
  if (process.platform !== 'win32') return Promise.reject(new LibraryError('本机没有可用的 Windows 目录选择器。', 501));
  return new Promise((resolve, reject) => {
    const script = "$OutputEncoding = New-Object System.Text.UTF8Encoding; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'DSHPlugin-RabbitHole：选择只读项目目录'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }";
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new LibraryError('目录选择器等待超时。', 504)); }, 120000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value.trim()); };
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => finish(new LibraryError(`目录选择器启动失败：${error.message}`, 500)));
    child.on('close', (code) => finish(null, code === 0 ? output : ''));
  });
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new LibraryError('资料超过本次保存的大小限制。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createLibraryHandler(library, metadata = {}) {
  let mutations = Promise.resolve();
  const handle = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/library')) return false;
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      // The server's Host/Origin gate plus a non-simple header block cross-site writes.
      if (req.method !== 'GET' && req.headers['x-dailydesk-request'] !== 'library') throw new LibraryError('此请求未从阅读界面发起。', 403);
      const parts = url.pathname.split('/').slice(3).map(decodeURIComponent);
      if(parts[0]!=='config'&&req.headers['x-dailydesk-library']&&decodeURIComponent(req.headers['x-dailydesk-library'])!==library.root)throw new LibraryError('保存目录已在另一窗口改变，请重新载入；当前草稿继续保留。',409);
      if (req.method === 'GET' && parts[0] === 'config') reply(200, { directory: library.root, format: 1, ...metadata });
      else if (req.method === 'POST' && parts[0] === 'config') {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
        const directory = await library.setRoot(body.directory);
        reply(200, { directory, format: 1, ...metadata });
      } else if (req.method === 'POST' && parts[0] === 'select-directory') {
        const directory = await chooseDirectory();
        reply(200, { directory: directory || null });
      } else if (parts[0] === 'skills' && req.method === 'GET') reply(200,(await library.skillCatalog(url.searchParams.get('project_id')||'default')).map(({content,...skill})=>skill));
      else if(parts[0]==='skills'&&req.method==='PUT')reply(200,await library.configureSkills(JSON.parse((await readBody(req,256*1024)).toString('utf8'))));
      else if (parts[0] === 'projects' && parts[1] === 'context' && parts.length === 2 && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
        if (!body || !Array.isArray(body.project_ids) || body.project_ids.some(id => typeof id !== 'string' || !id.trim()) || typeof body.q !== 'string') throw new LibraryError('项目上下文请求格式无效。', 400);
        reply(200, await library.projectContext(body.project_ids, body.q, { charBudget: body.budget || 120000 }));
      }
      else if (parts[0] === 'projects' && parts.length === 1 && req.method === 'GET') reply(200, await library.listProjects());
      else if (parts[0] === 'projects' && parts.length === 1 && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); reply(201, await library.createProject(body));
      } else if (parts[0] === 'projects' && parts.length === 2 && req.method === 'PUT') {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); reply(200, await library.updateProject(parts[1], body));
      } else if (parts[0] === 'projects' && parts.length === 2 && req.method === 'DELETE') reply(200, await library.deleteProject(parts[1]));
      else if (parts[0] === 'projects' && parts.length >= 3 && req.method === 'GET') {
        const id = parts[1]; const action = parts[2];
        if (action === 'tree') reply(200, await library.projectEntries(id, url.searchParams.get('path') || '', { depth: url.searchParams.get('depth'), limit: url.searchParams.get('limit'), rootIndex:url.searchParams.get('root') }));
        else if (action === 'read') reply(200, await library.readProjectFile(id, url.searchParams.get('path') || '',{rootIndex:url.searchParams.get('root')}));
        else if (action === 'search') reply(200, await library.searchProject(id, url.searchParams.get('q') || '', { limit: url.searchParams.get('limit') }));
        else throw new LibraryError('项目操作不存在。', 404);
      } else if (parts[0] === 'projects' && parts[1] === 'context' && req.method === 'GET') {
        const ids = (url.searchParams.get('project_ids') || '').split(',').map((id) => id.trim()).filter(Boolean);
        reply(200, await library.projectContext(ids, url.searchParams.get('q') || '', { charBudget: url.searchParams.get('budget') || 120000 }));
      }
      else if (req.method === 'GET' && parts.length === 0) reply(200, await library.list());
      else if (req.method === 'POST' && parts[0] === 'open') {
        if (process.platform === 'win32') { const child = spawn('explorer.exe', [library.root], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
        reply(200, { directory: library.root });
      } else {
        const id = parts[0]; const action = parts[1];
        if (!id) throw new LibraryError('缺少画布标识。', 400);
        if (req.method === 'GET' && !action) reply(200, await library.load(id));
        else if (req.method === 'PUT' && !action) {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          if (body.hole?.hole_id !== id) throw new LibraryError('画布标识不匹配。', 400);
          reply(200, await library.save(body.hole, body.revision, body.reason));
        } else if (req.method === 'DELETE' && !action) reply(200, await library.archive(id));
        else if (req.method === 'POST' && action === 'finish-recovery') reply(200, await library.finishRecovery(id));
        else if (req.method === 'GET' && action === 'assets' && !parts[2]) reply(200, await library.assets(id));
        else if (action === 'assets' && parts[2]) {
          if (req.method === 'PUT') { await library.putAsset(id, parts[2], await readBody(req, 128 * 1024 * 1024)); reply(200, { saved: true }); }
          else if (req.method === 'GET') {
            const bytes = await library.getAsset(id, parts[2]);
            if (!bytes) throw new LibraryError('附件不存在。', 404);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes);
          } else throw new LibraryError('不支持的附件操作。', 405);
        } else if (req.method === 'GET' && action === 'history') reply(200, await library.history(id, parts[2]));
        else if (req.method === 'GET' && action === 'version') reply(200, await library.version(id, parts[2], parts[3]));
        else if (req.method === 'POST' && action === 'restore') {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          reply(200, await library.restore(id, body.node_id, body.version_id, body.revision));
        } else throw new LibraryError('资料库操作不存在。', 404);
      }
    } catch (error) { reply(error.status || (error instanceof SyntaxError || error instanceof URIError ? 400 : 500), { error: error.message || '资料库保存失败。', ...error.details }); }
    return true;
  };
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/library')) return false;
    if (req.method === 'GET') {
      await mutations;
      return handle(req, res, url);
    }
    const result = mutations.then(() => handle(req, res, url));
    mutations = result.catch(() => {});
    return result;
  };
}
