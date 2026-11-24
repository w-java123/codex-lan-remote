import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from './config.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(lock) {
  const file = join(lock, 'pid');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
    const serverPid = Number(await readFile(join(lock, 'backend.pid'), 'utf8').catch(() => '0'));
    if (!pid || alive(pid) || alive(serverPid)) return false;
    await rm(file, { force: true });
    await rm(join(lock, 'backend.pid'), { force: true });
    await rm(join(lock, 'token.local'), { force: true });
    await rmdir(lock);
    await mkdir(lock);
  }
  await writeFile(file, String(process.pid), { flag: 'wx' });
  return true;
}

function relayConnection(request, socket, data, { route, port, token, onAttach, onDetach }) {
  if (request.url !== route || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = connect({ host: '127.0.0.1', port });
  let upgraded = false;
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('error', () => socket.destroy());
  upstream.once('close', () => {
    socket.destroy();
    if (upgraded) onDetach();
  });
  const headers = [
    'GET /rpc HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Connection: Upgrade', 'Upgrade: websocket',
    'Authorization: Bearer ' + token,
  ];
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.push(name + ': ' + value);
  }
  upstream.once('connect', () => {
    upstream.write(headers.join('\r\n') + '\r\n\r\n');
    if (data.length) upstream.write(data);
    socket.pipe(upstream);
  });
  let response = '';
  const handshake = chunk => {
    response += chunk.toString('latin1');
    if (!response.includes('\r\n')) {
      if (response.length > 1024) upstream.destroy();
      return;
    }
    upstream.off('data', handshake);
    if (response.startsWith('HTTP/1.1 101 ')) {
      upgraded = true;
      onAttach();
    }
  };
  upstream.on('data', handshake);
  upstream.pipe(socket);
}

export async function runSharedOwner({ dataDirectory, desktop, binary, env = process.env, onReady = () => {}, ignoreAlreadyRunning = true }) {
  const lock = join(dataDirectory, 'shared-owner.lock');
  const manifest = join(dataDirectory, 'shared-owner.local.json');
  if (!await acquireLock(lock)) {
    if (ignoreAlreadyRunning) return false;
    throw Error('共享桌面正在运行或启动，请先检查该窗口');
  }
  const token = randomBytes(32).toString('hex');
  const route = '/rpc/' + randomBytes(32).toString('hex');
  let backend, gui, relay, attached = false;
  let desktops = 0, leaseWrite = Promise.resolve(), closing = false;
  const connections = new Set();
  try {
    await rm(manifest, { force: true });
    // The parent data directory already has the plugin's per-user permissions.
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const listener = 'ws://127.0.0.1:' + port;
    const url = listener + '/rpc';
    backend = spawn(binary, ['app-server', '--listen', listener, '--ws-auth', 'capability-token', '--ws-token-sha256', tokenHash], {
      cwd: dirname(binary), env, windowsHide: true, stdio: 'ignore',
    });
    if (backend.pid) await writeFile(join(lock, 'backend.pid'), String(backend.pid), { flag: 'wx' });
    const backendExit = once(backend, 'exit');
    backendExit.catch(() => {});
    let ready = false;
    for (let i = 0; i < 60 && backend.exitCode === null; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + port + '/readyz', { signal: AbortSignal.timeout(180) })).ok; } catch {}
      if (ready) break;
      await delay(150);
    }
    if (!ready) throw Error('桌面共享 App Server 未就绪');
    const publish = () => {
      leaseWrite = leaseWrite.catch(() => {}).then(() => {
        if (closing || !desktops) return rm(manifest, { force: true });
        return atomicJson(manifest, { pid: process.pid, desktopPid: gui?.pid, url, token });
      });
      leaseWrite.catch(() => {});
    };
    relay = createHttpServer((_, reply) => { reply.writeHead(404); reply.end(); });
    relay.on('connection', socket => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    relay.on('upgrade', (request, socket, data) => relayConnection(request, socket, data, {
      route, port, token,
      onAttach: () => { desktops++; publish(); },
      onDetach: () => { desktops--; publish(); },
    }));
    const relayPort = await listen(relay);
    const childEnv = { ...env, CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:' + relayPort + route };
    delete childEnv.CODEX_APP_SERVER_FORCE_CLI;
    const desktopArgs = childEnv.CODEX_ELECTRON_USER_DATA_PATH ? ['--user-data-dir=' + childEnv.CODEX_ELECTRON_USER_DATA_PATH] : [];
    gui = spawn(desktop, desktopArgs, { cwd: dirname(desktop), env: childEnv, windowsHide: false, stdio: 'ignore' });
    const guiExit = once(gui, 'exit');
    guiExit.catch(() => {});
    for (let i = 0; i < 240 && !desktops && gui.exitCode === null && backend.exitCode === null; i++) await delay(250);
    if (!desktops) throw Error('桌面未连接共享 App Server，请关闭这个测试窗口后按原方式打开 Codex');
    attached = true;
    await leaseWrite;
    await onReady();
    console.log('Codex 桌面共享控制已连接');
    await Promise.race([guiExit, backendExit]);
  } finally {
    closing = true;
    // Dispose only our startup window before closing its relay if it never attached.
    if (!attached && gui?.pid && gui.exitCode === null) gui.kill();
    for (const socket of connections) socket.destroy();
    relay?.close();
    await leaseWrite.catch(() => {});
    await rm(manifest, { force: true });
    // Only the backend created by this launcher is eligible for termination.
    // Leave the desktop open on a transport failure so it can show its state.
    if (backend?.pid && backend.exitCode === null) backend.kill();
    await rm(join(lock, 'backend.pid'), { force: true });
    await rm(join(lock, 'pid'), { force: true });
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dataDirectory, desktop, binary] = process.argv.slice(2);
  await runSharedOwner({ dataDirectory, desktop, binary, ignoreAlreadyRunning:false }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
