import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { adminCall, dataRoot, ensureManager } from './client.mjs';
import { atomicJson, readJson } from './config.mjs';
import { resolveSharedDesktop } from '../server/desktop-binary.mjs';
import { runSharedOwner } from './shared-owner.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--data');
const root = resolve(index < 0 ? dataRoot() : args[index + 1]);
const statusPath = join(root, 'shared-launch-status.local.json');
const status = phase => atomicJson(statusPath, { phase });

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

try {
  const config = await readJson(join(root, 'config.local.json'), null);
  if (args.includes('--login') && config?.autoStart !== true) process.exit(0);
  await status('starting-gateway');
  const endpoint = await ensureManager(root);
  let state = await adminCall(endpoint, '/api/status');
  if (!state.gateway?.running) state = await adminCall(endpoint, '/api/start', {});
  if (!state.gateway?.running) throw Error('手机连接网关未就绪');

  const lease = await readJson(join(root, 'shared-owner.local.json'), null);
  if (running(lease?.pid) && running(lease?.desktopPid)) {
    await status('already-shared');
    process.exit(0);
  }

  if (args.includes('--desktop-existing')) {
    await status('ordinary-desktop-running');
    throw Error('手机连接网关已启动。请等普通 Codex 的任务结束并从桌面菜单退出，再双击「Codex 手机共享控制」。');
  }

  const {desktop, binary} = await resolveSharedDesktop(config?.codexBinary);
  await status('starting-shared-desktop');
  const active = await runSharedOwner({dataDirectory:root, desktop, binary, onReady:()=>status('ready')});
  await status(active === false ? 'already-starting' : 'closed');
} catch (error) {
  const current = await readJson(statusPath, null).catch(()=>null);
  if (current?.phase !== 'ordinary-desktop-running') await status('failed').catch(()=>{});
  console.error(error.message);
  process.exitCode = 1;
}
