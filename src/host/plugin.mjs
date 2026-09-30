import { startSurface, readJson, reply } from './surface.mjs';
import { readAssistantSource, saveSourceCanvas } from './source.mjs';
import { HOSTED_PORT, SERVICE_NAME } from '../shared/identity.mjs';
import { HostedRunner } from './hosted-runner.mjs';

export const name = 'dshplugin-rabbithole';
export const inject = ['webServer', 'sessions', 'agents', 'llm', 'tools', 'systemPrompt'];

export async function apply(ctx, config = {}) {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('DSHPlugin-RabbitHole 当前只支持本机 Web 宿主。');
  const parentOrigin = `http://127.0.0.1:${ctx.webServer.port}`;
  const surface = await startSurface({ port: config.port ?? HOSTED_PORT, profile: `hosted-${config.profile || 'default'}`, directory: config.dataDirectory, hosted: true, parentOrigin, createRunner: (library, directory) => new HostedRunner(ctx, library, directory) });
  const route = '/dshplugin-rabbithole/launch';
  let dispose;
  try {
    dispose = ctx.webServer.register({ kind: 'exact', path: route, handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== new URL(parentOrigin).host || (req.headers.origin && req.headers.origin !== parentOrigin)
        || req.headers['x-dshplugin-rabbithole'] !== 'workspace' || req.method !== 'POST') return reply(res, 403, { error: 'Request rejected' });
      try {
        const body = await readJson(req);
        let target = '/';
        let holeId = null;
        if (body.messageId || body.quote) {
          const source = readAssistantSource(ctx.sessions, body.sessionId, body.messageId, body);
          if (body.preview) return reply(res, 200, { source, projects: await surface.library.listProjects() });
          const saved = await saveSourceCanvas(surface.library, source, { projectId: body.projectId, question: body.question });
          holeId = saved.hole.hole_id;
          target = `/${saved.hole.hole_id}${body.question ? '?dshplugin_run=question' : ''}`;
        } else if (body.holeId) {
          const saved = await surface.library.load(body.holeId);
          if (!saved) throw new Error('这份画布不存在。');
          holeId = body.holeId;
          target = `/${holeId}${body.queued ? '?dshplugin_run=question' : ''}`;
        }
        reply(res, 200, { service: SERVICE_NAME, holeId, url: `${surface.origin}/connect?ticket=${surface.issueTicket(target)}` });
      } catch (error) { reply(res, 400, { error: error.message }); }
    } });
    ctx.effect(() => async () => { dispose(); await surface.close(); }, 'DSHPlugin-RabbitHole: owned surface');
    ctx.provide('dshpluginRabbitHole', { origin: surface.origin });
  } catch (error) { dispose?.(); await surface.close(); throw error; }
}
