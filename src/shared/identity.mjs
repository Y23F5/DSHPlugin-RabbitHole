import os from 'node:os';
import path from 'node:path';

export const SERVICE_NAME = 'DSHPlugin-RabbitHole';
export const VERSION = '0.1.0-dev.5';
export const DEV_PORT = 45231;
export const HOSTED_PORT = 45232;
export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('请输入 0 到 65535 之间的整数端口；0 表示自动分配。');
  }
  return port;
}
export function dataDirectory({ env = process.env, profile = 'development', directory } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid isolated profile name');
  const home = env.LOCALAPPDATA || env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return resolveDirectory(directory || env.DSHPLUGIN_RABBITHOLE_DATA_DIR || path.join(home, SERVICE_NAME, profile));
}
export function resolveDirectory(directory) {
  return path.resolve(directory);
}
