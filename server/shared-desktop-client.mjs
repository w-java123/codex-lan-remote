import { EventEmitter } from 'node:events';
import { messageInput } from './message-input.mjs';

const requests = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'item/tool/requestOptionPicker',
]);

export class SharedDesktopClient extends EventEmitter {
  sharedOwner = true;
  initialized = false;
  sequence = 0;
  pending = new Map();
  subscriptions = new Map();
  allowed;
  socket;

  constructor({ url, token, controlThreadIds = [], timeoutMs = 10000, isCurrent = () => true }) {
    super();
    const address = new URL(url);
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' ||
        address.username || address.password || address.pathname !== '/rpc' ||
        address.search || address.hash || !address.port || !/^[a-f0-9]{64}$/.test(token)) {
      throw Error('共享桌面连接必须是受验证的本机入口');
    }
    this.url = address.href;
    this.token = token;
    this.allowed = new Set(controlThreadIds);
    this.timeoutMs = Math.min(timeoutMs, 10000);
    this.isCurrent = isCurrent;
  }

  async connect() {
    if (this.initialized) return;
    const socket = new WebSocket(this.url, { headers: { Authorization: 'Bearer ' + this.token } });
    this.socket = socket;
    socket.addEventListener('message', event => {
      try { this.receive(JSON.parse(event.data)); } catch { socket.close(); }
    });
    socket.addEventListener('close', () => this.disconnected(socket));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('共享桌面连接超时')), this.timeoutMs);
        const finish = callback => {
          clearTimeout(timer);
          callback();
        };
        socket.addEventListener('open', () => finish(resolve), { once: true });
        socket.addEventListener('error', () => finish(() => reject(Error('共享桌面入口不可用'))), { once: true });
      });
      await this.request('initialize', { clientInfo: { name: 'codex_lan_shared', version: '0.5.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized' });
      this.initialized = true;
      this.leaseTimer = setInterval(() => { if (!this.isCurrent()) this.close(); }, 1000);
      this.leaseTimer.unref();
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  send(frame) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error('共享桌面已断开');
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
  }

  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('共享桌面未确认操作，请先刷新实际状态'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  receive(frame) {
    if (!frame.method) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(Error('共享桌面拒绝此操作，请刷新会话状态'));
      else pending.resolve(frame.result);
      return;
    }
    const { method, params = {} } = frame;
    const entry = this.subscriptions.get(params.threadId);
    if (!entry) return;
    if (frame.id !== undefined) {
      if (requests.has(method)) entry.requests.set(frame.id, { id: frame.id, method, params });
    } else if (method === 'serverRequest/resolved') {
      entry.requests.delete(params.requestId);
      entry.replies.get(params.requestId)?.finish();
    } else if (method === 'turn/started') {
      entry.active = params.turn;
    } else if (method === 'turn/completed') {
      if (entry.active?.id === params.turn?.id) entry.active = null;
      entry.liveItems.delete(params.turn?.id);
      for (const [id, request] of entry.requests) if (request.params.turnId == null || request.params.turnId === params.turn?.id) entry.requests.delete(id);
    } else if (method === 'thread/queue/changed') {
      this.emit('queueChanged', params.threadId);
      return;
    } else if (method === 'thread/settings/updated') {
      const settings = params.threadSettings;
      if (settings) entry.settings = { ...entry.settings, ...settings, reasoningEffort: settings.effort ?? settings.reasoningEffort ?? entry.settings?.reasoningEffort };
    } else if (method === 'item/started' || method === 'item/completed') {
      if (!params.turnId || !params.item?.id) return;
      const items = entry.liveItems.get(params.turnId) ?? new Map();
      items.set(params.item.id, params.item);
      entry.liveItems.set(params.turnId, items);
    } else if (method !== 'thread/status/changed') {
      return;
    }
    this.refreshSoon(params.threadId, entry);
  }

  refreshSoon(threadId, entry) {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.loadHistory(threadId).catch(() => {});
    }, 80);
    entry.timer.unref();
  }

  async discoverOwner(threadId) {
    let cursor;
    const seen = new Set();
    do {
      const page = await this.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (page.data?.includes(threadId)) return 'shared-app-server';
      cursor = page.nextCursor;
      if (seen.has(cursor)) break;
      seen.add(cursor);
    } while (cursor);
    throw Object.assign(Error('共享桌面尚未加载该会话'), { reason: 'no-client-found' });
  }

  async followThread(threadId) {
    if (this.subscriptions.has(threadId)) return;
    await this.discoverOwner(threadId);
    const entry = { revision: 0, requests: new Map(), replies: new Map(), liveItems: new Map(), active: null };
    this.subscriptions.set(threadId, entry);
    try {
      const { thread, cwd, model, reasoningEffort, serviceTier } = await this.request('thread/resume', { threadId, excludeTurns: true });
      if (thread?.id !== threadId) throw Error('共享桌面返回了不同会话');
      entry.cwd = cwd ?? thread.cwd;
      entry.settings = { model, reasoningEffort, serviceTier };
      await this.loadHistory(threadId);
    } catch (error) {
      this.unfollowThread(threadId);
      throw error;
    }
  }

  unfollowThread(threadId) {
    const entry = this.subscriptions.get(threadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.subscriptions.delete(threadId);
    for (const reply of entry.replies.values()) reply.finish(Error('会话连接已结束，请检查操作结果'));
    if (this.initialized) void this.request('thread/unsubscribe', { threadId }).catch(() => {});
  }

  async loadHistory(threadId) {
    const entry = this.subscriptions.get(threadId);
    if (!entry) return false;
    const revision = ++entry.revision;
    const page = await this.request('thread/turns/list', { threadId, limit: 15, sortDirection: 'desc', itemsView: 'full' });
    if (this.subscriptions.get(threadId) !== entry || entry.revision !== revision) return false;
    const turns = [...(page.data ?? [])].reverse();
    if (entry.active && !turns.some(turn => turn.id === entry.active.id)) turns.push(entry.active);
    this.emit('threadState', { conversationId: threadId, change: { type: 'snapshot', revision,
      conversationState: { id: threadId, cwd: entry.cwd, latestThreadSettings: entry.settings,
        latestReasoningEffort: entry.settings?.reasoningEffort,
        threadRuntimeStatus: { type: turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' },
        turns: turns.map(turn => {
          const items = new Map((turn.items ?? []).map(item => [item.id, item]));
          for (const [id, item] of entry.liveItems.get(turn.id) ?? []) if (!items.has(id)) items.set(id, item);
          return { ...turn, items: [...items.values()], turnId: turn.id, turnStartedAtMs: turn.startedAt ? turn.startedAt * 1000 : undefined };
        }),
        requests: [...entry.requests.values()],
      } } });
    return true;
  }

  enableThreadControl(threadId) { this.allowed.add(threadId); }

  requireControl(threadId) {
    if (!this.initialized || !this.isCurrent() || !this.allowed.has(threadId) || !this.subscriptions.has(threadId)) {
      throw Error('共享会话写入尚未授权或已断开');
    }
    return this.subscriptions.get(threadId);
  }

  async readModelSettings(threadId) { return this.subscriptions.get(threadId)?.settings; }

  async updateModelSettings(threadId, model, effort, { serviceTier } = {}) {
    this.requireControl(threadId);
    await this.request('thread/settings/update', { threadId, model, effort, ...(serviceTier === undefined ? {} : { serviceTier }) });
    const entry = this.requireControl(threadId);
    const { model: confirmedModel, reasoningEffort, serviceTier: confirmedTier } = await this.request('thread/resume', { threadId, excludeTurns: true });
    entry.settings = { model: confirmedModel, reasoningEffort, serviceTier: confirmedTier };
    await this.loadHistory(threadId);
    return { applied: confirmedModel === model && reasoningEffort === effort && (serviceTier === undefined || (confirmedTier ?? 'default') === serviceTier) };
  }

  async startTurn(threadId, text, { attachments, skills, cwd } = {}) {
    this.requireControl(threadId);
    const { id, input } = messageInput(text, { attachments, skills, cwd });
    const { queuedSubmission } = await this.request('thread/queue/add', { threadId, clientUserMessageId: id, input });
    if (!queuedSubmission?.id || queuedSubmission.clientUserMessageId !== id) throw Error('未确认提交，请检查桌面队列');
    try {
      this.requireControl(threadId);
      await this.request('thread/queue/start', { threadId, queuedSubmissionId: queuedSubmission.id });
      return { accepted: true };
    } catch {
      // A desktop-originated turn may have won the race. The owner still has
      // the original queue item and must decide when to start it.
      return { accepted: true, queued: true, nativeQueue: true, messageId: queuedSubmission.id };
    }
  }

  async steerTurn(threadId, text, { expectedTurnId, attachments, skills, cwd } = {}) {
    this.requireControl(threadId);
    if (!expectedTurnId) throw Error('该轮次已变化，请刷新');
    const { id, input } = messageInput(text, { attachments, skills, cwd });
    const result=await this.request('turn/steer', { threadId, expectedTurnId, clientUserMessageId: id, input });
    if(result?.turnId!==expectedTurnId)throw Error('桌面未确认插话已送达当前轮次，请刷新核对');
    return result;
  }

  interruptTurn(threadId, turnId) {
    this.requireControl(threadId);
    return this.request('turn/interrupt', { threadId, turnId });
  }

  compactThread(threadId) {
    this.requireControl(threadId);
    return this.request('thread/compact/start', { threadId });
  }

  reply(threadId, id, method, result) {
    const entry = this.requireControl(threadId);
    if (entry.requests.get(id)?.method !== method || entry.replies.has(id)) throw Error('该请求已处理或并未发给当前连接');
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        entry.replies.delete(id);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(Error('桌面未确认请求已处理，请先刷新')), this.timeoutMs);
      entry.replies.set(id, { finish });
      try { this.send({ id, result }); } catch (error) { finish(error); }
    });
  }

  replyCommandApproval(threadId, id, decision) { return this.reply(threadId, id, 'item/commandExecution/requestApproval', { decision }); }
  replyFileApproval(threadId, id, decision) { return this.reply(threadId, id, 'item/fileChange/requestApproval', { decision }); }
  replyToolApproval(threadId, id, action) { return this.reply(threadId, id, 'mcpServer/elicitation/request', { action, content: null }); }
  replyUserInput(threadId, id, answers) { return this.reply(threadId, id, 'item/tool/requestUserInput', { answers }); }

  disconnected(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.initialized = false;
    clearInterval(this.leaseTimer);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(Error('共享桌面已断开，请先检查操作结果'));
    }
    this.pending.clear();
    for (const entry of this.subscriptions.values()) {
      clearTimeout(entry.timer);
      for (const reply of entry.replies.values()) reply.finish(Error('共享桌面已断开，请检查请求状态'));
    }
    this.subscriptions.clear();
    this.emit('disconnected');
  }

  close() {
    const socket = this.socket;
    if (!socket) return;
    this.disconnected(socket);
    socket.close();
  }
}
