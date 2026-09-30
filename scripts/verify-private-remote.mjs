import { execFileSync } from 'node:child_process';
const urls = execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { encoding: 'utf8' }).trim().split(/\r?\n/);
const target = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Y23F5\/DSHPlugin-RabbitHole(?:\.git)?\/?$/i;
if (!urls.length || urls.some(url => !target.test(url))) throw new Error('Push rejected: origin must be Y23F5/DSHPlugin-RabbitHole.');
