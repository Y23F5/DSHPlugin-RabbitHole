import { execFileSync } from 'node:child_process';
import './verify-private-remote.mjs';
execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
execFileSync('git', ['config', 'remote.pushDefault', 'origin']);
execFileSync('git', ['config', 'push.default', 'simple']);
console.log('Push guard installed for Y23F5/DSHPlugin-RabbitHole.');
