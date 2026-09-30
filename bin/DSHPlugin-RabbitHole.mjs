#!/usr/bin/env node
import { startSurface } from '../src/host/surface.mjs';
import { DEV_PORT, SERVICE_NAME } from '../src/shared/identity.mjs';

process.title = SERVICE_NAME;
const surface = await startSurface({ port: process.env.DSHPLUGIN_RABBITHOLE_PORT ?? DEV_PORT });
console.log(`${SERVICE_NAME} ${surface.origin}/connect?ticket=${surface.issueTicket()}`);
console.log(`Data: ${surface.dataDirectory}`);
let stopping;
function stop() { return stopping ||= surface.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { if (value.trim() === 'stop') void stop().then(() => process.stdin.pause()); });
