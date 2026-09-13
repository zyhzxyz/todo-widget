// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { BusinessStore, CONNECTION_KEY, LOCAL_KEYS } from '../../src/data/businessStore';
import { parseBackup } from '../../src/data/backup';
import { normalizeServerUrl } from '../../src/data/api';
import { emptyBusiness, type BusinessData, type Todo } from '../../shared/domain.ts';
import { Store } from '../src/store.ts';
import { buildApp } from '../src/app.ts';
import { restoreTodo, trashTodo } from '../../shared/recycle.ts';
const APP = 'desktop-test-only-00000000000000000000000000';
const BOT = 'bot-test-only-000000000000000000000000000000';
const URL = 'http://127.0.0.1:3210';
let directory: string, db: Store, app: FastifyInstance, stores: BusinessStore[], original: BusinessData;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
function todo(title = 'New task'): Todo {
  return { id: randomUUID(), title, completed: false, priority: 'normal', listId: 'list-inbox', completionDates: [], isGroup: false, collapsed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), timeEntries: [], totalTimeSpent: 0 };
}
async function injectFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input).replace(URL, '');
  const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path, headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
  return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
}
function createStore() {
  const store = new BusinessStore(() => ({ todos: JSON.parse(localStorage.getItem(LOCAL_KEYS.todos)!), lists: JSON.parse(localStorage.getItem(LOCAL_KEYS.lists)!), diary: JSON.parse(localStorage.getItem(LOCAL_KEYS.diary)!) }), { transport });
  stores.push(store); return store;
}
async function settled(store: BusinessStore) { await vi.waitFor(() => expect(['online', 'offline', 'conflict', 'locked']).toContain(store.getSnapshot().status)); }
async function saved(store: BusinessStore) { await vi.waitFor(() => { expect(store.getSnapshot().hasPending).toBe(false); expect(store.getSnapshot().status).toBe('online'); }); }
async function connect() { const store = createStore(); store.start(); await store.connect(URL, APP); return store; }

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); stores = [];
  original = emptyBusiness(); original.todos = [todo('Original Windows-like local task')];
  for (const key of ['todos', 'lists', 'diary'] as const) localStorage.setItem(LOCAL_KEYS[key], JSON.stringify(original[key]));
  directory = mkdtempSync(join(tmpdir(), 'todo-desktop-test-'));
  db = new Store(join(directory, 'todo.db'), 'Asia/Shanghai');
  app = await buildApp({ dbPath: '', timeZone: 'Asia/Shanghai', appToken: APP, botToken: BOT, host: '127.0.0.1', port: 3210, origins: [] }, { store: db });
  transport = vi.fn(injectFetch);
});
afterEach(async () => { stores.forEach(store => store.dispose()); await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });

it('connecting never uploads local tasks; remote edits do not overwrite legacy keys', async () => {
  const store = await connect();
  expect(store.getSnapshot().data.todos).toEqual([]);
  store.set('todos', [todo('Remote only')]); await saved(store);
  expect(db.snapshot().todos[0].title).toBe('Remote only');
  expect(JSON.parse(localStorage.getItem(LOCAL_KEYS.todos)!)).toEqual(original.todos);
  store.useLocal(); expect(store.getSnapshot().data.todos).toEqual(original.todos);
  expect(db.snapshot().todos[0].title).toBe('Remote only');
});
it('batches list and task changes in one transaction, not transient invalid references', async () => {
  const store = await connect(); const task = { ...todo(), listId: 'custom' };
  store.set('lists', current => [...current, { id: 'custom', name: 'Work', createdAt: new Date().toISOString() }]);
  store.set('todos', [task]); await saved(store);
  expect(db.revision()).toBe(1); expect(db.snapshot().todos[0].listId).toBe('custom');
  expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/mutations'))).toHaveLength(1);
});
it('persists exact operation before HTTP, replays a lost response without duplicate creation', async () => {
  const store = await connect();
  let drop = true;
  transport.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/mutations')) {
      expect(localStorage.getItem(`todo-widget.remote-pending:${URL}`)).toContain('mutationId');
      const response = await injectFetch(url, init);
      if (drop) { drop = false; throw new TypeError('simulated lost response'); }
      return response;
    }
    return injectFetch(url, init);
  });
  store.set('todos', [todo()]);
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('offline'));
  expect(store.getSnapshot().hasPending).toBe(true); expect(db.snapshot().todos).toHaveLength(1);
  expect(store.set('todos', [todo('Must not write offline')])).toBe(false);
  await store.retry(); await saved(store);
  expect(db.revision()).toBe(1); expect(db.snapshot().todos).toHaveLength(1);
  const bodies = transport.mock.calls.filter(([url]) => String(url).endsWith('/mutations')).map(([, init]) => init?.body);
  expect(bodies[0]).toBe(bodies[1]);
});
it('recovers pending writes after restart using the same journaled operation', async () => {
  const store = await connect();
  transport.mockImplementation(async (url, init) => { const result = await injectFetch(url, init); if (String(url).endsWith('/mutations')) throw new TypeError('lost response'); return result; });
  store.set('todos', [todo()]); await vi.waitFor(() => expect(store.getSnapshot().status).toBe('offline'));
  store.dispose(); transport.mockImplementation(injectFetch);
  const reopened = createStore(); reopened.start(); await saved(reopened);
  expect(db.revision()).toBe(1); expect(reopened.getSnapshot().data.todos).toHaveLength(1);
});
it('does not send if pending journal cannot be written', async () => {
  const store = await connect();
  const originalSet = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
    if (key.includes('remote-pending')) throw new Error('quota exceeded');
    return originalSet.call(this, key, value);
  });
  try {
    store.set('todos', [todo()]); await vi.waitFor(() => expect(store.getSnapshot().status).toBe('offline'));
    expect(db.revision()).toBe(0); expect(store.getSnapshot().hasPending).toBe(true);
    expect(store.makeBackup().business.todos).toHaveLength(1);
  } finally { spy.mockRestore(); }
});
it('does not overwrite a bot edit; conflict retains exportable work until explicit discard', async () => {
  const store = await connect();
  await app.inject({ method: 'POST', url: '/api/v1/bot/actions', headers: { authorization: `Bearer ${BOT}` }, payload: { mutationId: randomUUID(), expectedRevision: 0, action: 'create', task: { title: 'QQ task' } } });
  store.set('todos', [todo('Desktop draft')]); await vi.waitFor(() => expect(store.getSnapshot().status).toBe('conflict'));
  expect(store.makeBackup().business.todos[0].title).toBe('Desktop draft');
  expect(db.snapshot().todos.map(t => t.title)).toEqual(['QQ task']);
  expect(() => store.useLocal()).toThrow();
  await store.discardPending();
  expect(store.getSnapshot().data.todos[0].title).toBe('QQ task');
});
it('a stale read in flight cannot roll back an optimistic/confirmed write', async () => {
  const store = await connect();
  let release!: (response: Response) => void;
  let captured!: Response;
  transport.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/state')) { captured = await injectFetch(url, init); return new Promise<Response>(resolve => { release = resolve; }); }
    return injectFetch(url, init);
  });
  const refreshing = store.refresh(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  store.set('todos', [todo('Keep newest')]); await saved(store);
  release(captured); await refreshing;
  expect(store.getSnapshot().data.todos[0].title).toBe('Keep newest'); expect(store.getSnapshot().revision).toBe(1);
});
it('offline/locked startup shows isolated read-only cache, never silently local data', async () => {
  const store = await connect(); store.set('todos', [todo('Cached remote')]); await saved(store); store.dispose();
  sessionStorage.clear(); const reopened = createStore(); reopened.start();
  expect(reopened.getSnapshot().status).toBe('locked');
  expect(reopened.getSnapshot().data.todos[0].title).toBe('Cached remote');
  expect(reopened.set('todos', [])).toBe(false);
  expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!)).not.toHaveProperty('token');
});
it('bad credentials do not switch local mode or claim a successful save', async () => {
  const store = createStore(); store.start();
  await expect(store.connect(URL, 'wrong')).rejects.toThrow();
  expect(store.getSnapshot().mode).toBe('local'); expect(store.getSnapshot().data.todos).toEqual(original.todos);
  expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
});
it('explicit JSON migration previews counts, then preserves original local data', async () => {
  const store = await connect(); const backup = store.makeBackup('local');
  // Tests run in a controlled local timezone; keep the account calendar explicit.
  backup.timeZone = 'Asia/Shanghai';
  const preview = await store.previewImport(backup); expect(preview.canImport).toBe(true);
  await store.importBackup(backup, preview.revision); await saved(store);
  expect(db.snapshot().todos[0].id).toBe(original.todos[0].id);
  expect(JSON.parse(localStorage.getItem(LOCAL_KEYS.todos)!)).toEqual(original.todos);
  expect((await store.previewImport(backup)).canImport).toBe(false);
});
it('completed timer sessions stopped offline are journaled, then restored once', async () => {
  const store = await connect(); const task = todo(); store.set('todos', [task]); await saved(store);
  transport.mockRejectedValueOnce(new TypeError('offline')); await store.refresh();
  expect(store.getSnapshot().status).toBe('offline');
  const entry = { id: randomUUID(), startTime: '2026-09-13T00:00:00Z', endTime: '2026-09-13T00:01:05Z', duration: 65 };
  expect(store.preserveTimer(task.id, entry)).toBe(true);
  expect(store.getSnapshot().timerRecoveryCount).toBe(1); expect(db.snapshot().todos[0].totalTimeSpent).toBe(0);
  expect(() => store.recoverTimers()).toThrow();
  await store.refresh(); store.recoverTimers(); await saved(store);
  expect(db.snapshot().todos[0].totalTimeSpent).toBe(65); expect(store.getSnapshot().timerRecoveryCount).toBe(0);
  store.preserveTimer(task.id, entry); store.recoverTimers(); await saved(store);
  expect(db.snapshot().todos[0].totalTimeSpent).toBe(65); expect(store.getSnapshot().timerRecoveryCount).toBe(0);
});
it('accepts current/four-key JSON backups but never a LevelDB or corrupt partial import', () => {
  const store = createStore();
  const backup = store.makeBackup('local');
  expect(parseBackup(JSON.stringify(backup)).business.todos).toHaveLength(1);
  const legacy = { 'todo-widget.todos': JSON.stringify(original.todos), 'todo-widget.lists': original.lists, 'todo-widget.diary': [] };
  expect(parseBackup(JSON.stringify(legacy)).business.todos).toHaveLength(1);
  expect(() => parseBackup('not JSON')).toThrow();
  expect(() => parseBackup(JSON.stringify({ 'todo-widget.todos': [{ title: 'partial' }] }))).toThrow();
});
it('rejects plaintext remote URLs and embedded credentials before sending secrets', () => {
  expect(normalizeServerUrl('https://todo.example.com/')).toBe('https://todo.example.com');
  expect(normalizeServerUrl(URL)).toBe(URL);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#token']) expect(() => normalizeServerUrl(url)).toThrow();
});

it.each(['{broken', 'null', '{"path":"/mutations","body":{}}'])('never overwrites a damaged pending journal (%s) on reconnect or background refresh', async raw => {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify({ mode: 'remote', baseUrl: URL }));
  localStorage.setItem(`todo-widget.remote-pending:${URL}`, raw);
  sessionStorage.setItem(`todo-widget.session-token:${URL}`, APP);
  const store = createStore(); store.start();
  expect(store.getSnapshot().status).toBe('storage-error');
  await expect(store.connect(URL, APP)).rejects.toThrow();
  await store.refresh(); await store.retry();
  expect(store.canWrite).toBe(false); expect(store.getSnapshot().hasPending).toBe(true);
  expect(localStorage.getItem(`todo-widget.remote-pending:${URL}`)).toBe(raw);
  expect(() => store.useLocal()).toThrow();
  expect(db.revision()).toBe(0);
  await store.discardPending(); await store.connect(URL, APP);
  expect(store.canWrite).toBe(true);
});
it('protects a damaged journal found when explicitly connecting from local mode', async () => {
  localStorage.setItem(`todo-widget.remote-pending:${URL}`, '{broken');
  const store = createStore(); store.start(); await store.connect(URL, APP);
  expect(store.getSnapshot().status).toBe('storage-error');
  await store.refresh();
  expect(store.canWrite).toBe(false); expect(store.getSnapshot().hasPending).toBe(true);
  expect(localStorage.getItem(`todo-widget.remote-pending:${URL}`)).toBe('{broken');
});
it('keeps one stable checkpoint per timer and only discards recovery explicitly', async () => {
  const store = createStore(); const task = original.todos[0];
  const entry = { id: randomUUID(), startTime: '2026-09-13T00:00:00Z', endTime: '2026-09-13T00:00:05Z', duration: 5 };
  store.preserveTimer(task.id, entry);
  store.preserveTimer(task.id, { ...entry, endTime: '2026-09-13T00:00:10Z', duration: 10 });
  const reopened = createStore(); expect(reopened.getTimerRecoveries().entries).toHaveLength(1);
  expect(reopened.getTimerRecoveries().entries[0].entry.duration).toBe(10);
  reopened.discardTimerRecoveries(); expect(createStore().getSnapshot().timerRecoveryCount).toBe(0);
  expect(JSON.parse(localStorage.getItem(LOCAL_KEYS.todos)!)).toEqual(original.todos);
});

it('syncs recoverable deletion/restoration without overwriting original local data', async () => {
  const first = await connect();
  const task = { ...todo('Recycle round trip'), completionDates: ['2026-09-12'], notes: 'Synthetic note', totalTimeSpent: 25 };
  first.set('todos', [task]); await saved(first);
  const second = await connect();
  first.set('todos', rows => trashTodo(rows, task.id, new Date().toISOString(), randomUUID())); await saved(first);
  await second.refresh();
  expect(second.getSnapshot().data.todos[0].deletedAt).toBeTruthy();
  const exported = parseBackup(JSON.stringify(second.makeBackup()));
  expect(exported.business.todos[0]).toMatchObject({ notes: 'Synthetic note', totalTimeSpent: 25, completionDates: ['2026-09-12'] });
  second.set('todos', rows => restoreTodo(rows, task.id, new Date().toISOString())); await saved(second);
  await first.refresh();
  expect(first.getSnapshot().data.todos[0].deletedAt).toBeUndefined();
  expect(first.getSnapshot().data.todos[0].totalTimeSpent).toBe(25);
  expect(JSON.parse(localStorage.getItem(LOCAL_KEYS.todos)!)).toEqual(original.todos);
});

it('pulls other-client changes on the 5-second cadence and immediately on focus/online', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let desktop: BusinessStore | undefined;
  try {
    desktop = await connect();
    const createRemoteTask = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/mutations', headers: { authorization: `Bearer ${APP}` }, payload: {
        expectedRevision: db.revision(), mutationId: randomUUID(), operations: [{ type: 'todo.put', value: todo('Other client') }],
      } });
      expect(response.statusCode).toBe(200);
    };
    await createRemoteTask();
    await vi.advanceTimersByTimeAsync(4999);
    expect(desktop.getSnapshot().data.todos).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(desktop!.getSnapshot().data.todos).toHaveLength(1));
    await createRemoteTask(); window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(desktop!.getSnapshot().data.todos).toHaveLength(2));
    await createRemoteTask(); window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(desktop!.getSnapshot().data.todos).toHaveLength(3));
  } finally { desktop?.dispose(); vi.useRealTimers(); }
});
