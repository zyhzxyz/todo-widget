import { backupSchema, businessSchema, diffBusiness, emptyBusiness, mutationSchema, snapshotSchema, type Backup, type BusinessData, type Mutation, type Snapshot, type TimeEntry } from '../../shared/domain';
import { ApiClient, normalizeServerUrl, RemoteError } from './api';

export const LOCAL_KEYS = { todos: 'todo-widget.todos', lists: 'todo-widget.lists', diary: 'todo-widget.diary' } as const;
export const CONNECTION_KEY = 'todo-widget.connection';
const cacheKey = (url: string) => `todo-widget.remote-cache:${url}`;
const pendingKey = (url: string) => `todo-widget.remote-pending:${url}`;
const tokenKey = (url: string) => `todo-widget.session-token:${url}`;
export type DataStatus = 'storage-error' | 'local' | 'connecting' | 'online' | 'saving' | 'offline' | 'locked' | 'conflict';
export type DataView = {
  data: BusinessData; mode: 'local' | 'remote'; status: DataStatus; baseUrl: string;
  revision: number | null; timeZone: string; error: string; hasPending: boolean; timerRecoveryCount: number;
};
type TimerRecovery = { todoId: string; entry: TimeEntry & { id: string } };
type Setter<T> = T | ((current: T) => T);
type Pending = { path: '/mutations' | '/import'; body: { mutationId: string; expectedRevision: number } & Record<string, unknown>; optimistic: BusinessData };
type SaveResult = { snapshot: Snapshot; committedRevision: number; replayed: boolean };
export type ImportPreview = { canImport: boolean; revision: number; counts: { tasks: number; lists: number; diary: number }; note: string };
export type ServerStatus = { revision: number; timeZone: string; binding: { senderId: string; platformId: string; session: string } | null; reminders: Record<string, number> };
function parseJSON(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key); return raw === null ? null : JSON.parse(raw);
}
function business(snapshot: BusinessData): BusinessData { return { lists: snapshot.lists, todos: snapshot.todos, diary: snapshot.diary }; }
function message(error: unknown): string {
  if (error instanceof RemoteError) {
    if (error.status === 409) return `服务器已变化或操作冲突，本次修改尚未应用。请先导出待保存内容，再放弃修改并刷新。（${error.code}）`;
    if (error.status === 401 || error.status === 403) return '认证失败：请重新输入桌面 token。不会退回本地写入。';
    return `服务器拒绝保存：${error.message}`;
  }
  return '连接失败或响应未确认。当前只读；若有待保存操作，可用原操作编号安全重试。';
}

/** One owner for business state; no write-through effects that upload stale whole arrays. */
export class BusinessStore {
  private view: DataView;
  private confirmed: Snapshot | null = null;
  private client: ApiClient | null = null;
  private pending: Pending | null = null;
  private stagedBase: BusinessData | null = null;
  private listeners = new Set<() => void>();
  private local: Storage;
  private session: Storage;
  private loadLocal: () => BusinessData;
  private transport: typeof fetch;
  private interval: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private sequence = 0;
  private polling = false;
  private sending = false;
  private connecting = false;
  private timerRecoveries: TimerRecovery[] = [];
  private localZone: string;
  constructor(loadLocal: () => BusinessData, options: { local?: Storage; session?: Storage; transport?: typeof fetch } = {}) {
    this.local = options.local ?? localStorage;
    this.session = options.session ?? sessionStorage;
    this.loadLocal = loadLocal;
    this.transport = options.transport ?? ((...args) => fetch(...args));
    this.localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let localData = emptyBusiness();
    let localError = '';
    try { localData = loadLocal(); } catch { localError = '本地业务数据格式异常，已进入只读保护，没有用示例数据覆盖。请导出原始存储后修复。'; }
    this.view = { data: localData, mode: 'local', status: localError ? 'storage-error' : 'local', baseUrl: '', revision: null, timeZone: this.localZone, error: localError, hasPending: false, timerRecoveryCount: 0 };
    try {
      const saved = parseJSON(this.local, CONNECTION_KEY) as { mode?: string; baseUrl?: string } | null;
      if (saved?.mode === 'remote' && saved.baseUrl) {
        const baseUrl = normalizeServerUrl(saved.baseUrl);
        this.view = { ...this.view, mode: 'remote', status: 'locked', baseUrl, data: emptyBusiness(), error: '请输入桌面 token 连接；只读缓存不会写回本地任务。' };
        try {
          const cached = snapshotSchema.parse(parseJSON(this.local, cacheKey(baseUrl)));
          this.confirmed = cached;
          this.view = { ...this.view, data: business(cached), revision: cached.revision, timeZone: cached.timeZone };
        } catch { /* A corrupt/missing cache is never permission to overwrite the server. */ }
        this.readPending(baseUrl);
        const token = this.session.getItem(tokenKey(baseUrl));
        if (token) { this.client = new ApiClient(baseUrl, token, this.transport); this.view.status = 'connecting'; }
      }
    } catch { this.view = { ...this.view, status: 'storage-error', hasPending: this.view.mode === 'remote', error: '连接配置或待保存日志损坏，已只读保护。请导出原始记录，没有修改远程数据。' }; }
    this.loadTimerRecoveries();
  }
  getSnapshot = (): DataView => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get canWrite(): boolean { return this.view.status === 'local' || this.view.status === 'online'; }
  private emit(patch: Partial<DataView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach(fn => fn()); }
  private readPending(baseUrl: string) {
    const raw = this.local.getItem(pendingKey(baseUrl));
    if (raw === null) return;
    // Even JSON null is a damaged existing journal, not an absent operation.
    this.view = { ...this.view, hasPending: true };
    const saved = JSON.parse(raw) as Pending;
    if (!saved || !['/mutations', '/import'].includes(saved.path)) throw new Error('Invalid pending operation');
    const body = saved.path === '/mutations' ? mutationSchema.parse(saved.body) : mutationSchema.pick({ mutationId: true, expectedRevision: true }).extend({ backup: backupSchema }).strict().parse(saved.body);
    this.pending = { ...saved, body, optimistic: businessSchema.parse(saved.optimistic) };
    this.view = { ...this.view, data: this.pending.optimistic, hasPending: true, error: '上次写入尚未确认，连接后会用同一编号重试，不能继续离线编辑。' };
  }
  start() {
    if (this.active) return;
    this.active = true;
    if (this.view.mode === 'local' && this.view.status === 'local') this.persistLocal(this.view.data);
    else if (this.client) void this.retry();
    this.interval = setInterval(() => { if (this.active && !this.pending && !this.stagedBase) void this.refresh(); }, 5_000);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('online', this.onFocus);
  }
  dispose() {
    this.active = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('online', this.onFocus);
    // Do not cancel an accepted write or generate a new operation ID on React StrictMode replay.
  }
  private onFocus = () => { if (!this.pending && !this.stagedBase) void this.refresh(); };
  private persistLocal(data: BusinessData) {
    try { for (const key of ['todos', 'lists', 'diary'] as const) this.local.setItem(LOCAL_KEYS[key], JSON.stringify(data[key])); this.acknowledgeTimers(data); }
    catch { this.emit({ error: '本机存储写入失败；请立即导出备份，不要关闭应用。' }); }
  }
  set<K extends keyof BusinessData>(key: K, update: Setter<BusinessData[K]>): boolean {
    if (!this.canWrite) { this.emit({ error: this.view.error || '当前只读，修改未提交。请先恢复连接。' }); return false; }
    const previous = this.view.data[key];
    const next = typeof update === 'function' ? update(previous) : update;
    if (next === previous) return true;
    this.sequence++;
    if (this.view.mode === 'local') {
      this.emit({ data: { ...this.view.data, [key]: next } }); this.persistLocal(this.view.data); return true;
    }
    if (!this.stagedBase) { this.stagedBase = this.view.data; queueMicrotask(() => { void this.flush(); }); }
    this.emit({ data: { ...this.view.data, [key]: next }, hasPending: true });
    return true;
  }
  private async flush() {
    if (!this.stagedBase || !this.confirmed) return;
    const operations = diffBusiness(this.stagedBase, this.view.data);
    this.stagedBase = null;
    if (operations.length === 0) { this.emit({ hasPending: false }); return; }
    const body: Mutation = { mutationId: crypto.randomUUID(), expectedRevision: this.confirmed.revision, operations };
    this.pending = { path: '/mutations', body: { ...body }, optimistic: this.view.data };
    await this.savePending();
  }
  private async savePending() {
    if (!this.pending || !this.client || this.sending) return;
    const pending = this.pending;
    // Journal the exact request before it can reach the network. No response => same ID on retry.
    try { this.local.setItem(pendingKey(this.view.baseUrl), JSON.stringify(pending)); }
    catch { this.emit({ status: 'offline', hasPending: true, error: '无法保留待保存操作，尚未发送到服务器。请导出备份或释放本机存储。' }); return; }
    this.sending = true;
    this.emit({ status: 'saving', error: '', hasPending: true });
    try {
      const result = await this.client.request<SaveResult>(pending.path, pending.body);
      const snapshot = snapshotSchema.parse(result.snapshot);
      this.confirmed = snapshot;
      this.pending = null;
      let journalError = '';
      try { this.local.removeItem(pendingKey(this.view.baseUrl)); } catch { journalError = '服务器已保存，但本机旧操作日志未清理；重启后安全重放。'; }
      this.acceptSnapshot(snapshot);
      if (journalError) this.emit({ error: journalError });
    } catch (error) {
      this.emit({ status: error instanceof RemoteError && error.status === 409 ? 'conflict' : error instanceof RemoteError && [401, 403].includes(error.status) ? 'locked' : 'offline', error: message(error), hasPending: true });
    } finally { this.sending = false; }
  }
  private acceptSnapshot(snapshot: Snapshot) {
    this.confirmed = snapshot;
    this.acknowledgeTimers(snapshot);
    let error = '';
    try { this.local.setItem(cacheKey(this.view.baseUrl), JSON.stringify(snapshot)); }
    catch { error = '服务器数据已确认，但本机只读缓存写入失败。'; }
    this.emit({ data: business(snapshot), revision: snapshot.revision, timeZone: snapshot.timeZone, status: 'online', error, hasPending: false });
  }
  async refresh() {
    if (!this.client || this.view.mode !== 'remote' || this.view.hasPending || this.pending || this.stagedBase || this.polling || this.sending || this.connecting) return;
    const sequence = this.sequence;
    this.polling = true;
    try {
      const snapshot = await this.client.state();
      if (sequence === this.sequence && !this.view.hasPending && !this.pending && !this.stagedBase) this.acceptSnapshot(snapshot);
    } catch (error) {
      if (sequence === this.sequence && !this.view.hasPending && !this.pending && !this.stagedBase) this.emit({ status: error instanceof RemoteError && [401, 403].includes(error.status) ? 'locked' : 'offline', error: message(error) });
    } finally { this.polling = false; }
  }
  async connect(rawUrl: string, token: string) {
    const baseUrl = normalizeServerUrl(rawUrl);
    if (!token.trim() || /\s/.test(token.trim())) throw new Error('请输入有效桌面 token。');
    if (this.connecting || this.sending || this.stagedBase || (this.view.hasPending && (!this.pending || baseUrl !== this.view.baseUrl))) throw new Error('先处理待保存操作，再切换服务器。');
    if (this.view.timerRecoveryCount && baseUrl !== this.view.baseUrl) throw new Error('先处理待补记计时，再切换数据源。');
    const previous = this.view;
    const previousClient = this.client;
    const previousConfirmed = this.confirmed;
    this.connecting = true;
    const client = new ApiClient(baseUrl, token.trim(), this.transport);
    this.sequence++;
    this.emit({ status: 'connecting', error: '' });
    try {
      const snapshot = await client.state();
      // Validate the target journal before enabling writes or changing connection settings.
      if (!this.pending) {
        this.emit({ mode: 'remote', baseUrl });
        try { this.readPending(baseUrl); } catch {
          this.local.setItem(CONNECTION_KEY, JSON.stringify({ mode: 'remote', baseUrl }));
          this.session.setItem(tokenKey(baseUrl), token.trim());
          this.client = client; this.confirmed = snapshot;
          this.emit({ data: business(snapshot), status: 'storage-error', hasPending: true, error: '待保存日志损坏，不能继续写入。请先导出未确认原始记录，再明确放弃该日志。' });
          return;
        }
      }
      this.local.setItem(CONNECTION_KEY, JSON.stringify({ mode: 'remote', baseUrl }));
      this.session.setItem(tokenKey(baseUrl), token.trim());
      this.client = client;
      this.confirmed = snapshot;
      this.emit({ mode: 'remote', baseUrl, revision: snapshot.revision, timeZone: snapshot.timeZone });
      this.loadTimerRecoveries();
      if (this.pending) { this.emit({ data: this.pending.optimistic, hasPending: true }); await this.savePending(); }
      else this.acceptSnapshot(snapshot);
    } catch (error) {
      this.client = previousClient; this.confirmed = previousConfirmed;
      this.emit({ ...previous, status: previous.mode === 'local' ? previous.status : 'offline', error: message(error) });
      throw new Error(message(error));
    } finally { this.connecting = false; }
  }
  async retry() {
    if (this.pending) await this.savePending(); else await this.refresh();
  }
  async discardPending() {
    if (this.sending || this.stagedBase) throw new Error('正在发送，请等待请求结束。');
    this.sequence++;
    // The user must explicitly confirm this operation in the UI.
    this.local.removeItem(pendingKey(this.view.baseUrl));
    this.pending = null;
    this.emit({ data: this.confirmed ? business(this.confirmed) : emptyBusiness(), hasPending: false, status: 'offline', error: '正在重新读取服务器，未覆盖任何远端数据。' });
    await this.refresh();
  }
  useLocal() {
    if (this.pending || this.view.hasPending || this.stagedBase || this.sending || this.connecting || this.view.timerRecoveryCount) throw new Error('请先导出或处理待保存操作，再切回本地。');
    const localData = this.loadLocal();
    this.sequence++;
    if (this.view.baseUrl) this.session.removeItem(tokenKey(this.view.baseUrl));
    this.local.removeItem(CONNECTION_KEY);
    this.client = null; this.confirmed = null;
    this.emit({ data: localData, mode: 'local', status: 'local', baseUrl: '', revision: null, timeZone: this.localZone, error: '', hasPending: false });
    this.loadTimerRecoveries();
  }
  rawLocalBackup() {
    return Object.fromEntries([...Object.values(LOCAL_KEYS), 'todo-widget.settings'].map(key => [key, this.local.getItem(key)]));
  }
  recoveryBundle() {
    return { format: 'todo-widget.unsaved-recovery', version: 1, source: this.view.baseUrl, journal: this.local.getItem(pendingKey(this.view.baseUrl)), visibleData: this.view.data, timers: this.getTimerRecoveries() };
  }
  makeBackup(source: 'current' | 'local' = 'current'): Backup {
    const local = source === 'local';
    let settings: Record<string, unknown> | undefined;
    try { settings = JSON.parse(this.local.getItem('todo-widget.settings') ?? '{}'); } catch { /* Business backup still works. */ }
    return backupSchema.parse({ format: 'todo-widget.backup', version: 1, exportedAt: new Date().toISOString(), timeZone: local ? this.localZone : this.view.timeZone, business: local ? this.loadLocal() : this.view.data, deviceSettings: settings });
  }
  async previewImport(backup: Backup): Promise<ImportPreview> {
    if (!this.client || this.view.status !== 'online' || this.view.hasPending) throw new Error('请先连接服务器并处理待保存操作。');
    return this.client.request('/import/preview', backup);
  }
  async importBackup(backup: Backup, expectedRevision: number) {
    if (!this.client || this.view.status !== 'online' || this.view.hasPending) throw new Error('服务器目前不能导入。');
    this.sequence++;
    this.pending = { path: '/import', body: { mutationId: crypto.randomUUID(), expectedRevision, backup: backupSchema.parse(backup) }, optimistic: backup.business };
    this.emit({ data: backup.business, hasPending: true });
    await this.savePending();
  }
  private timerKey() { return `todo-widget.timer-recovery:${this.view.mode === 'remote' ? this.view.baseUrl : 'local'}`; }
  private loadTimerRecoveries() {
    try {
      const saved = parseJSON(this.local, this.timerKey());
      this.timerRecoveries = Array.isArray(saved) ? saved.filter((r: TimerRecovery) => r?.todoId && r.entry?.id && Number.isFinite(r.entry.duration) && r.entry.duration > 0) : [];
      this.emit({ timerRecoveryCount: this.timerRecoveries.length });
    } catch { this.emit({ error: '计时恢复记录读取失败，请保留本机存储副本。' }); }
  }
  preserveTimer(todoId: string, entry: TimeEntry & { id: string }): boolean {
    if (entry.duration <= 0) return true;
    const next = [...this.timerRecoveries.filter(r => r.entry.id !== entry.id), { todoId, entry }];
    try {
      this.local.setItem(this.timerKey(), JSON.stringify(next));
      this.timerRecoveries = next;
      this.emit({ timerRecoveryCount: next.length });
      return true;
    } catch { this.emit({ error: '计时恢复日志无法写入，请保持计时器开启并释放本机存储。' }); return false; }
  }
  private acknowledgeTimers(data: BusinessData) {
    const next = this.timerRecoveries.filter(r => !data.todos.some(t => t.id === r.todoId && t.timeEntries.some(e => e.id === r.entry.id)));
    if (next.length === this.timerRecoveries.length) return;
    try {
      this.local.setItem(this.timerKey(), JSON.stringify(next)); this.timerRecoveries = next;
      this.emit({ timerRecoveryCount: next.length });
    } catch { /* Keeping the recovery copy is safe; stable entry IDs prevent double counting. */ }
  }
  getTimerRecoveries() { return { format: 'todo-widget.timer-recovery', version: 1, source: this.view.baseUrl || 'local', entries: this.timerRecoveries }; }
  discardTimerRecoveries() {
    // Caller must confirm and must stop any running timer first.
    this.local.removeItem(this.timerKey());
    this.timerRecoveries = [];
    this.emit({ timerRecoveryCount: 0 });
  }
  recoverTimers() {
    if (!this.canWrite) throw new Error('先恢复连接，再补记计时。');
    const missing = this.timerRecoveries.filter(r => !this.view.data.todos.some(t => t.id === r.todoId));
    this.set('todos', current => current.map(todo => {
      const entries = this.timerRecoveries.filter(r => r.todoId === todo.id && !todo.timeEntries.some(e => e.id === r.entry.id)).map(r => r.entry);
      return entries.length ? { ...todo, timeEntries: [...todo.timeEntries, ...entries], totalTimeSpent: todo.totalTimeSpent + entries.reduce((sum, e) => sum + e.duration, 0), updatedAt: new Date().toISOString() } : todo;
    }));
    this.acknowledgeTimers(this.view.mode === 'local' ? this.view.data : this.confirmed ?? emptyBusiness());
    if (missing.length) this.emit({ error: '原任务已被删除，部分计时不能补记。请导出计时恢复记录，不会自动加到别的任务。' });
  }
  async serverStatus(): Promise<ServerStatus> {
    if (!this.client) throw new Error('尚未连接服务器。');
    return this.client.request('/status');
  }
  async unbind() {
    if (!this.client) throw new Error('尚未连接服务器。');
    await this.client.request('/binding', undefined, 'DELETE');
  }
}
