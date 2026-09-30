import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['build.mjs'], {
    cwd: new URL('../packages/rabbithole/', import.meta.url),
    env: { ...process.env, RABBITHOLE_PROXY_URL: '', RABBITHOLE_COMMIT: '' }, stdio: 'inherit', windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Canvas build exited ${code}`)));
});
await fs.mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/client/index.jsx'], outfile: 'dist/client.js',
  bundle: true, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'],
  target: 'es2022', sourcemap: false,
  banner: { js: 'window.__ModuleLoader__.load({ id: "@y23f5/dshplugin-rabbithole", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
console.log('DSHPlugin-RabbitHole: Canvas and DSH client built.');
