import { watchFile, unwatchFile } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
export const PINNED_SECTION_ID='01984de2-8f74-7c91-a3b2-5c5e937cf318';

// Read only selected desktop sidebar fields; never forward the persisted state.
export async function desktopSidebar(root = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  try { return JSON.parse(await readFile(path.join(root, '.codex-global-state.json'), 'utf8')); } catch { return {}; }
}
export function watchDesktopSidebar(onChange, root = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  const file = path.join(root, '.codex-global-state.json');
  watchFile(file, { interval: 500, persistent: false }, onChange);
  return () => unwatchFile(file, onChange);
}
const desktopHome = () => process.env.CODEX_HOME || path.join(homedir(), '.codex');
const desktopStateDatabase = '.codex-global-state.sqlite';

export async function desktopQueuedFollowUps(root = desktopHome()) {
  const filename = path.join(root, desktopStateDatabase);
  try { await stat(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return (await desktopSidebar(root))['queued-follow-ups'];
  }
  const database = new DatabaseSync(filename, {readOnly:true});
  try {
    const row = database.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?')
      .get('global', 'queued-follow-ups');
    return row ? JSON.parse(row.value) : {};
  } finally { database.close(); }
}

export function watchDesktopQueue(onChange, root = desktopHome()) {
  const files = [desktopStateDatabase, desktopStateDatabase + '-wal'].map(name => path.join(root, name));
  for (const file of files) watchFile(file, {interval:500,persistent:false}, onChange);
  return () => { for (const file of files) unwatchFile(file, onChange); };
}

export function groupThreads(threads, state = {}) {
  const projects = Object.values(state['local-projects'] || {});
  const assignments = state['thread-project-assignments'] || {};
  const projectless = new Set(state['projectless-thread-ids'] || []);
  const order = state['project-order'] || [];
  const manual = state['sidebar-project-thread-orders'] || {};
  const ownerStates = Object.entries(state).filter(([key]) => key.startsWith('electron-owner-atoms:'));
  const owner = state['electron-owner-atoms:' + state['electron-renderer-content-owner']]
    ?? (ownerStates.length === 1 ? ownerStates[0][1] : undefined);
  const atoms = { ...state['electron-persisted-atom-state'], ...owner };
  const prefs = atoms['flat-project-sidebar-preferences-v1'] || {};
  const savedChats = atoms['codex-sidebar-chat-order-v1']?.threadIds || [];
  const looseOrder = new Map(savedChats.map((id,index)=>[id,index]));
  const identity = atoms['local-document-identity'];
  const identityKey = identity?.accountId && identity?.userId
    ? createHash('sha256').update(JSON.stringify(['chatgpt', identity.accountId, identity.userId])).digest('hex')
    : undefined;
  const unreadHosts = state['electron-thread-read-state-v1']?.unreadByIdentity?.[identityKey];
  const localUnread = Object.entries(unreadHosts || {}).filter(([host]) => host.startsWith('local:'));
  const unreadIds = localUnread.length === 1 && Array.isArray(localUnread[0][1])
    ? new Set(localUnread[0][1]) : undefined;
  const pinned=state._desktopPinnedIds??state['pinned-thread-ids']??[];
  const projectPins = state['pinned-project-ids'] || [];
  const unifiedPins = atoms['unified-sidebar-pinned-order-v1'];
  const orderedPins = Array.isArray(unifiedPins)
    ? unifiedPins.filter(key => typeof key === 'string' && key.startsWith('codex:project:'))
      .map(key => key.slice(14)).filter(id => projectPins.includes(id))
    : [];
  const pinnedProjects = [...new Set([...orderedPins, ...projectPins])];
  const unified=atoms['unified-sidebar-project-order-v1'];
  const projectOrder=Array.isArray(unified)?unified.filter(id=>typeof id==='string'&&id.startsWith('codex:project:')).map(id=>id.slice(14)):order;
  const recentOrder = new Map(threads.map(({id,updatedAt})=>({id,updatedAt:Number(updatedAt)||0}))
    .sort((a,b)=>b.updatedAt-a.updatedAt).map(({id},index)=>[id,index]));
  const pinnedByActivity = ['updated_at','priority'].includes(atoms['pinned-sidebar-sort-mode-v1']);
  const normalized = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const result = threads.map((thread, index) => {
    const assigned = assignments[thread.id];
    let project = projects.find(p => p.id === (assigned?.projectId || thread.projectId));
    if (!project && !projectless.has(thread.id) && !assigned) {
      const cwd = normalized(thread.cwd);
      let longestMatch = 0;
      for (const candidate of projects) {
        for (const root of candidate.rootPaths || []) {
          const folder = normalized(root);
          if (folder.length > longestMatch && (cwd === folder || cwd.startsWith(folder + '/'))) {
            project = candidate;
            longestMatch = folder.length;
          }
        }
      }
    }
    const section = thread.section;
    const pinIndex=pinned.indexOf(thread.id),isPinned=pinIndex>=0||(!state._desktopPinnedIds&&section?.id===PINNED_SECTION_ID);
    const projectPinIndex=project?pinnedProjects.indexOf(project.id):-1;
    const groupId = section?.id || (project ? 'project:' + project.id : 'chats');
    const savedOrder = manual[project?.id];
    const positions = Array.isArray(savedOrder) ? savedOrder : savedOrder?.threadIds || [];
    const manualIndex = prefs.projectSortMode === 'manual' ? positions.indexOf(thread.id) : -1;
    const fallbackOrder = recentOrder.get(thread.id);
    const conversationOrder = groupId.startsWith('project:') && prefs.projectSortMode === 'manual'
      ? manualIndex >= 0 ? manualIndex : positions.length + fallbackOrder
      : groupId === 'chats' && prefs.chatSortMode === 'manual'
        ? looseOrder.get(thread.id) ?? looseOrder.size + fallbackOrder : fallbackOrder;
    return { id:thread.id, name:thread.name || thread.preview?.slice(0,70) || '未命名聊天', updatedAt:thread.updatedAt, unread:unreadIds ? unreadIds.has(thread.id) : thread.readState?.firstUnread != null,
      groupId:isPinned?'pinned':groupId, groupName:isPinned?'置顶':section?.name || project?.name || '其他会话',pinned:isPinned,projectPinned:!isPinned&&!section&&projectPinIndex>=0,
      groupOrder:isPinned?-20000:section ? -1 : projectPinIndex>=0?-10000+projectPinIndex:project ? (projectOrder.indexOf(project.id) < 0 ? projectOrder.length : projectOrder.indexOf(project.id)) : projectOrder.length + 1,
      order:isPinned?(pinnedByActivity?fallbackOrder:pinIndex<0?pinned.length+index:pinIndex):conversationOrder };
  });
  if(prefs.projectSortMode==='updated_at'){
    const recentProjects = new Map();
    for (const row of result) if (row.groupId.startsWith('project:') && !row.projectPinned) {
      const at=Number(row.updatedAt)||0;
      const previous=recentProjects.get(row.groupId);
      if (!previous || at>previous.at) recentProjects.set(row.groupId,{at,rank:row.groupOrder});
    }
    const projectRanks=new Map([...recentProjects].sort(([,a],[,b])=>b.at-a.at||a.rank-b.rank)
      .map(([id],index)=>[id,index]));
    for (const row of result) if (projectRanks.has(row.groupId)) row.groupOrder=projectRanks.get(row.groupId);
  }
  if(prefs.mode==='list'||prefs.mode==='connection')for(const row of result)if(row.groupId==='chats'||row.groupId.startsWith('project:')){row.groupId='chats';row.groupName=prefs.mode==='connection'?'这台电脑':'全部会话';row.groupOrder=order.length+1;row.order=prefs.chatSortMode==='manual'
    ? looseOrder.get(row.id) ?? looseOrder.size + recentOrder.get(row.id) : recentOrder.get(row.id);}
  return result.sort((a,b) => a.groupOrder-b.groupOrder || a.groupId.localeCompare(b.groupId) || a.order-b.order);
}
