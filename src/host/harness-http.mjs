import { readJson, reply } from './surface.mjs';

export function createHarnessHandler(runner) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/harness')) return false;
    if (!runner) { reply(res, 503, { error: '请在 DSH Web 宿主中打开插件，再使用宿主模型提问。' }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/harness/catalog') { reply(res, 200, await runner.catalog()); return true; }
    if (req.method === 'GET' && url.pathname === '/api/harness/modes') { reply(res, 200, { modes: [{ id: 'hosted', label: '当前 DSH 宿主', available: true }] }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/harness/capabilities') { reply(res, 200, { capabilities: { hosted: true, tools: true, project_readonly: true, live_stream: true } }); return true; }
    if (req.method !== 'POST' || url.pathname !== '/api/harness/run') { reply(res, 404, { error: 'Harness route not found' }); return true; }
    if (req.headers['x-dailydesk-request'] !== 'harness') { reply(res, 403, { error: 'Request rejected' }); return true; }
    const body = await readJson(req);
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.flushHeaders?.();
    const send = event => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try { await runner.run(body, send, controller.signal); }
    catch (error) { send({ type: 'run/error', message: error.message }); }
    finally { if (!res.writableEnded) res.end(); }
    return true;
  };
}
