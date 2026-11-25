import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { adminCall, ensureManager } from './client.mjs';
import { atomicJson, readJson } from './config.mjs';
import { desktopVersion } from './version.mjs';

const plugin = fileURLToPath(new URL('..', import.meta.url));
const repo = 'w-java123/codex-lan-remote';
const max = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const statusFile = root => join(root, 'update-status.local.json');
export const desktopUpdateStatus = root => readJson(statusFile(root), null);

export async function checkDesktopUpdate() {
  const response = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Codex-LAN-Desktop' },
    signal: AbortSignal.timeout(12000), redirect: 'error',
  });
  if (!response.ok) throw Error('无法检查 GitHub 更新');
  const release = await response.json();
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    return { version: desktopVersion, available: false };
  }
  const marker = /<!--\s*codex-lan-update:\s*(\{[^>]+\})\s*-->/.exec(release.body || '');
  const version = marker && JSON.parse(marker[1]).desktopVersion;
  if (!versionPattern.test(version) || !versionPattern.test(desktopVersion)) return { version: desktopVersion, available: false };
  const newer = version.localeCompare(desktopVersion, 'en', { numeric: true }) > 0;
  const page = 'https://github.com/' + repo + '/releases/tag/' + release.tag_name;
  const name = 'codex-lan-windows-from-' + desktopVersion + '.json.gz';
  const asset = release.assets?.find(row => row.name === name && row.state === 'uploaded' && row.size > 0 &&
    row.size < max && /^sha256:[a-f0-9]{64}$/.test(row.digest));
  const patch = asset && { size: asset.size, digest: asset.digest,
    url: 'https://github.com/' + repo + '/releases/download/' + release.tag_name + '/' + name };
  return { version, available: newer, page, ...(newer && patch ? { patch } : {}) };
}

export async function startDesktopUpdate(root, running) {
  if (process.platform !== 'win32') throw Error('此更新仅适用于 Windows');
  const release = await checkDesktopUpdate();
  if (!release.available || !release.patch) throw Error('没有适用的增量，请从发行页下载完整包');
  const dir = join(root, 'desktop-update.lock');
  await mkdir(dir).catch(() => { throw Error('已有更新正在执行'); });
  try {
    const { size, digest, url } = release.patch;
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const destination = new URL(response.url);
    if (!response.ok || destination.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com',
      'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(destination.hostname)) throw Error('增量下载失败');
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > size) throw Error('增量包大小不符');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (received !== size || 'sha256:' + hash(bytes) !== digest) throw Error('增量包校验失败');
    const patch = JSON.parse(gunzipSync(bytes, { maxOutputLength: max }));
    if (patch.from !== desktopVersion || patch.to !== release.version) throw Error('增量版本不匹配');
    await prepareFiles(plugin, patch);
    await atomicJson(join(dir, 'patch.json'), { patch, running, ownerPid: process.pid });
    await atomicJson(statusFile(root), { state: 'applying', version: release.version });
    await new Promise((ok, fail) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--apply', root], {
        detached: true, windowsHide: true, stdio: 'ignore',
      });
      child.once('error', fail);
      child.once('spawn', () => { child.unref(); ok(); });
    });
    return { updating: true };
  } catch (error) {
    await rm(join(dir, 'patch.json'), { force: true });
    await rmdir(dir).catch(() => {});
    await atomicJson(statusFile(root), { state: 'failed' }).catch(() => {});
    throw error;
  }
}

export async function prepareFiles(directory, patch) {
  if (!Array.isArray(patch.files) || patch.files.length === 0 || patch.files.length > 100) throw Error('增量文件列表无效');
  const base = await realpath(directory), visited = new Set(), files = [];
  for (const row of patch.files) {
    const name = row.path;
    if (typeof name !== 'string' || !/^(?:desktop|server)\/(?:[\w-]+\/)*[\w-]+\.(?:mjs|js|html|css|json)$/.test(name) ||
      visited.has(name.toLowerCase())) throw Error('增量文件路径无效');
    visited.add(name.toLowerCase());
    const target = join(base, name);
    const parent = await realpath(dirname(target));
    const parentPath = relative(base, parent).split(sep).join('/');
    if (parentPath !== name.slice(0, name.lastIndexOf('/'))) throw Error('增量父目录无效');
    const present = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (present && (!present.isFile() || present.isSymbolicLink() || present.size > max)) throw Error('安装路径不安全');
    const previous = present ? await readFile(target) : null;
    if ((previous ? hash(previous) : null) !== row.before) throw Error('安装内容与增量基线不符，请下载完整包');
    const next = typeof row.data === 'string' ? Buffer.from(row.data, 'base64') : null;
    if ((next ? hash(next) : null) !== row.after || (row.data !== null && !next)) throw Error('增量文件校验失败');
    files.push({ target, previous, next });
  }
  const marker = files.find(row => row.target === join(base, 'desktop', 'release.json'));
  if (!marker?.next || JSON.parse(marker.next).version !== patch.to) throw Error('增量缺少新版版本标记');
  return files;
}

async function replace(target, bytes) {
  if (bytes === null) return rm(target, { force: true });
  const temp = target + '.codex-update-' + process.pid;
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, target); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function apply(root) {
  const lock = join(root, 'desktop-update.lock'), path = join(lock, 'patch.json');
  const changed = [];
  let restore = false;
  try {
    const { patch, running, ownerPid } = JSON.parse(await readFile(path, 'utf8'));
    const files = await prepareFiles(plugin, patch);
    const endpoint = await readJson(join(root, 'manager.local.json'), null);
    if (!endpoint || endpoint.pid !== ownerPid) throw Error('原网关已变更');
    await adminCall(endpoint, '/api/shutdown', {});
    restore = running;
    for (let i = 0; i < 80 && await readJson(join(root, 'manager.local.json'), null); i++) await delay(250);
    if (await readJson(join(root, 'manager.local.json'), null)) throw Error('旧网关尚未退出');
    for (const row of files) { await replace(row.target, row.next); changed.push(row); }
    const ready = await ensureManager(root);
    const state = await adminCall(ready, '/api/status');
    if (state.version !== patch.to) throw Error('新网关版本未确认');
    if (running && !state.gateway.running) {
      const restarted = await adminCall(ready, '/api/start', {});
      if (!restarted.gateway.running) throw Error('网关未就绪');
    }
    await atomicJson(statusFile(root), { state: 'ready', version: patch.to });
  } catch {
    if (changed.length) {
      const endpoint = await readJson(join(root, 'manager.local.json'), null);
      if (endpoint) await adminCall(endpoint, '/api/shutdown', {}).catch(() => {});
      for (let i = 0; i < 80 && await readJson(join(root, 'manager.local.json'), null); i++) await delay(250);
      for (const row of changed.reverse()) await replace(row.target, row.previous).catch(() => {});
    }
    const endpoint = await ensureManager(root).catch(() => null);
    if (restore && endpoint) await adminCall(endpoint, '/api/start', {}).catch(() => {});
    await atomicJson(statusFile(root), { state: 'failed' }).catch(() => {});
  } finally {
    await rm(path, { force: true }).catch(() => {});
    await rmdir(lock).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
    process.argv[2] === '--apply') await apply(resolve(process.argv[3]));
