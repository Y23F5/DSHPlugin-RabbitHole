import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { IsolatedLibrary, claimDirectory } from '../storage/isolated-library.mjs';
import { createLibraryHandler } from '../storage/library-http.mjs';
import { SERVICE_NAME, VERSION, DEV_PORT, validatePort, dataDirectory } from '../shared/identity.mjs';
import { createHarnessHandler } from './harness-http.mjs';
import { LibraryError } from '../storage/reading-library.mjs';

const webRoot = fileURLToPath(new URL('../../packages/rabbithole/web/dist/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
export function reply(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
export async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function startSurface(options = {}) {
  const port = validatePort(options.port ?? DEV_PORT);
  const directory = await claimDirectory(dataDirectory(options));
  await fs.access(path.join(webRoot, 'index.html'));
  const library = await new IsolatedLibrary(path.join(directory, 'library'), { configFile: path.join(directory, 'library-config.json') }).init();
  const runner = options.createRunner?.(library, directory) || null;
  library.beforeRootChange = () => {
    if (runner?.active.size) throw new LibraryError('请结束当前回答后切换资料库。', 409);
  };
  const handleHarness = createHarnessHandler(runner);
  const instance = randomUUID();
  const session = randomBytes(32).toString('hex');
  // Cookies are shared between ports: give each surface its own cookie name.
  const cookieName = `dsh-rabbithole-${port || instance}`;
  const tickets = new Map();
  const handleLibrary = createLibraryHandler(library, {
    service: SERVICE_NAME, instance, runtime: { pid: process.pid, version: VERSION, mode: options.hosted ? 'hosted' : 'development' },
  });
  let origin; let closing;
  const active = new Set();
  const parentOrigin = options.parentOrigin || null;
  const server = http.createServer(async (req, res) => {
    active.add(res); res.once('close', () => active.delete(res));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${parentOrigin ? ` ${parentOrigin}` : ''}`);
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return reply(res, 403, { error: 'Origin rejected' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/connect' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket');
        const entry = tickets.get(ticket);
        if (!entry || entry.expires < Date.now()) return reply(res, 401, { error: '启动链接已过期，请从所属入口重新打开。' });
        tickets.delete(ticket);
        res.writeHead(303, { 'Set-Cookie': `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`, Location: entry.path });
        return res.end();
      }
      const authenticated = (req.headers.cookie || '').split(';').some(item => item.trim() === `${cookieName}=${session}`);
      if (!authenticated) return reply(res, 401, { error: '请通过 DSHPlugin-RabbitHole 启动链接打开。' });
      if (closing) return reply(res, 503, { error: 'Service stopping' });
      if (url.pathname === '/api/plugin/status') return reply(res, 200, { service: SERVICE_NAME, version: VERSION, instance, pid: process.pid, origin, parentOrigin, dataDirectory: directory, mode: options.hosted ? 'hosted' : 'development', generation: !!runner });
      if (await handleLibrary(req, res, url)) return;
      if (await handleHarness(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: '接口不存在。' });
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed' });
      const decoded = decodeURIComponent(url.pathname);
      const file = path.resolve(webRoot, '.' + decoded);
      const relative = path.relative(webRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return reply(res, 403, { error: 'Path rejected' });
      const target = !path.extname(file) || decoded === '/' ? path.join(webRoot, 'index.html') : file;
      let content = await fs.readFile(target);
      if (target.endsWith('index.html')) content = Buffer.from(content.toString('utf8').replace('<title>Rabbithole — an infinite canvas for learning</title>', `<title>${SERVICE_NAME}</title>`));
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) reply(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await library.close(); throw error; }
  return {
    origin, library, instance, dataDirectory: directory,
    issueTicket(target = '/') {
      if (!/^\/[a-zA-Z0-9_-]*(\?dshplugin_run=[a-zA-Z0-9_-]+)?$/.test(target)) throw new Error('Invalid canvas destination');
      for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
      if (tickets.size > 100) throw new Error('Too many pending launches');
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { expires: Date.now() + 120000, path: target });
      return ticket;
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        await runner?.close();
        const done = new Promise(resolve => server.close(resolve));
        server.closeIdleConnections();
        const timer = setTimeout(() => server.closeAllConnections(), 3000);
        try { await done; await library.close(); }
        finally { clearTimeout(timer); tickets.clear(); }
      })();
      return closing;
    },
  };
}
