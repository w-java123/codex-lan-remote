import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dataRoot } from './client.mjs';
import { readJson, atomicJson } from './config.mjs';

const index = process.argv.indexOf('--data');
let statusPath;
try {
  const root = resolve(index < 0 ? dataRoot() : process.argv[index + 1]);
  statusPath = join(root, 'background-status.local.json');
  await atomicJson(statusPath, { phase: 'launching' });
  const config = await readJson(join(root, 'config.local.json'), null);
  const enabled = config?.autoStart === true;
  await atomicJson(statusPath, { phase: 'configured', enabled });
  if (enabled) {
    await import('./daemon.mjs');
    await atomicJson(statusPath, { phase: 'ready', pid: process.pid });
    process.on('exit', code => {
      try { writeFileSync(statusPath, JSON.stringify({ phase: 'exited', code })); } catch {}
    });
  }
} catch (error) {
  const status = { phase: 'launcher-failed', code: 1, reason: error.code || error.name };
  try {
    await atomicJson(statusPath, status);
  } catch {
    await atomicJson(join(tmpdir(), 'codex-lan-startup-status.local.json'), status).catch(() => {});
  }
  process.exit(1);
}
