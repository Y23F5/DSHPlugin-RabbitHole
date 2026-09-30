import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.runtime');
const sourceArg = process.argv.indexOf('--dsh-source');
const candidates = [
  sourceArg >= 0 ? process.argv[sourceArg + 1] : process.env.DSH_SOURCE_DIR,
  path.resolve(root, '../../Code-github/deepseek-harness'),
].filter(Boolean);
let cli;
for (const source of candidates) {
  const candidate = path.resolve(source, 'apps/cli/lib/bin.js');
  if (await fs.access(candidate).then(() => true, () => false)) { cli = candidate; break; }
}
if (!cli) throw new Error('请通过 DSH_SOURCE_DIR 或 --dsh-source 指定本机 DeepSeek Harness 源码目录。');

process.title = 'DSHPlugin-RabbitHole Workspace';
process.env.DSH_HOME = path.join(runtime, 'workspace-dsh');
process.env.DSH_AGENTS_HOME = path.join(runtime, 'workspace-agents');
process.env.DSHPLUGIN_RABBITHOLE_DATA_DIR = path.join(runtime, 'workspace-library');
process.env.DSH_TELEMETRY_DISABLED = '1';
await fs.mkdir(runtime, { recursive: true });
const execute = promisify(execFile);
const options = { cwd: root, env: process.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
const profile = 'rabbithole';
const profileDirectory = path.join(process.env.DSH_HOME, 'profiles', profile);
if (!(await fs.access(path.join(profileDirectory, 'package.json')).then(() => true, () => false))) {
  await execute(process.execPath, [cli, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], options);
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const installed = await fs.readFile(path.join(profileDirectory, 'node_modules/@y23f5/dshplugin-rabbithole/package.json'), 'utf8').then(JSON.parse, () => null);
if (installed?.version !== manifest.version) {
  const tarball = path.join(runtime, `y23f5-dshplugin-rabbithole-${manifest.version}.tgz`);
  await fs.access(tarball).catch(() => { throw new Error('请先运行 npm pack --pack-destination .runtime 生成工作区安装包。'); });
  console.log('正在安装 RabbitHole 工作区…');
  await execute(process.execPath, [cli, 'plugin', '--profile', profile, 'add', tarball], options);
}

const requireDsh = createRequire(cli);
const { loadLayeredEnv } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')));
const { runProfile } = await import(pathToFileURL(path.join(path.dirname(cli), 'profile-boot.js')));
const portArg = process.argv.indexOf('--port');
const args = ['--port', portArg >= 0 ? process.argv[portArg + 1] : '45240'];
if (process.argv.includes('--no-open')) args.push('--no-open');
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh'), profile, patchFiles: [], args });
if (!ctx.get('dshpluginRabbitHole')) {
  await shutdown.shutdown(1);
  throw new Error('RabbitHole 插件加载失败，请查看上方具体错误。');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', input => {
  if (input.trim() === 'stop') { process.stdin.pause(); void shutdown.shutdown(0); }
});
console.log('DSHPlugin-RabbitHole 工作区已启动；Ctrl+C 或输入 stop 关闭。');
