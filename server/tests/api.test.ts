import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { backupDatabase } from '../src/backup.ts';
import { readConfig, type ServerConfig } from '../src/config.ts';
import { backupSchema, emptyBusiness, type BusinessData, type Todo } from '../../shared/domain.ts';
import { dateInZone, wallToInstant } from '../../shared/time.ts';
import { restoreTodo, trashTodo } from '../../shared/recycle.ts';

const APP_TOKEN = 'app-test-only-000000000000000000000000000000';
const BOT_TOKEN = 'bot-test-only-000000000000000000000000000000';
const baseNow = Date.parse('2026-09-13T00:00:00Z');
let directory: string, store: Store, app: FastifyInstance, now: number, config: ServerConfig;
const headers = (bot = false) => ({ authorization: `Bearer ${bot ? BOT_TOKEN : APP_TOKEN}` });
function task(overrides: Partial<Todo> = {}): Todo {
  return { id: randomUUID(), title: 'Synthetic task', completed: false, priority: 'normal', listId: 'list-inbox', completionDates: [], isGroup: false, collapsed: false, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), timeEntries: [], totalTimeSpent: 0, ...overrides };
}
async function put(todo: Todo, expectedRevision = store.revision(), mutationId = randomUUID()) {
  return app.inject({ method: 'POST', url: '/api/v1/mutations', headers: headers(), payload: { expectedRevision, mutationId, operations: [{ type: 'todo.put', value: todo }] } });
}
async function botAction(action: object) {
  return app.inject({ method: 'POST', url: '/api/v1/bot/actions', headers: headers(true), payload: { expectedRevision: store.revision(), mutationId: randomUUID(), ...action } });
}
function bind() { return store.bind({ senderId: '100000001', platformId: 'test-qq', session: 'test-qq:FriendMessage:100000001' }); }
const backup = (business: BusinessData) => ({ format: 'todo-widget.backup', version: 1, exportedAt: new Date(now).toISOString(), timeZone: config.timeZone, business, deviceSettings: { alwaysOnTop: true } });

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'todo-api-test-'));
  now = baseNow;
  config = { dbPath: join(directory, 'todo.db'), timeZone: 'Asia/Shanghai', appToken: APP_TOKEN, botToken: BOT_TOKEN, host: '127.0.0.1', port: 3210, origins: ['tauri://localhost'] };
  store = new Store(config.dbPath, config.timeZone, () => now);
  app = await buildApp(config, { store });
});
afterEach(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

describe('security and validation', () => {
  it('health is public but state requires a credential; origins are explicit', async () => {
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/state')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/state', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const denied = await app.inject({ url: '/api/v1/state', headers: { ...headers(), origin: 'https://evil.invalid' } });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ url: '/api/v1/state', headers: { ...headers(), origin: 'tauri://localhost' } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.headers['access-control-allow-origin']).toBe('tauri://localhost');
  });
  it('preflight works without sending tokens; no wildcard origins', async () => {
    const result = await app.inject({ method: 'OPTIONS', url: '/api/v1/mutations', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(result.statusCode).toBe(204);
    expect(result.headers['access-control-allow-origin']).toBe('tauri://localhost');
  });
  it('bot cannot read diary, export or desktop state, and app cannot impersonate bot', async () => {
    for (const url of ['/api/v1/state', '/api/v1/export', '/api/v1/status']) expect((await app.inject({ url, headers: headers(true) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/bot/tasks', headers: headers() })).statusCode).toBe(403);
    const todo = task({ completionNotes: 'private-journal', timeEntries: [{ startTime: new Date(now).toISOString(), duration: 2 }] });
    expect((await put(todo)).statusCode).toBe(200);
    const view = (await app.inject({ url: '/api/v1/bot/tasks', headers: headers(true) })).json();
    expect(view).not.toHaveProperty('diary');
    expect(view.tasks[0]).not.toHaveProperty('timeEntries');
    expect(JSON.stringify(view)).not.toContain('private-journal');
  });
  it.each([
    { deletedAt: '2026-09-13T00:00:00Z' }, { deletionBatchId: randomUUID() },
    { dueDate: '2026-02-30' }, { totalTimeSpent: -1 }, { title: '' }, { listId: 'missing-list' },
    { parentId: 'missing-task' }, { goalStartDate: '2026-09-13' },
    { goalStartDate: '2026-09-14', goalEndDate: '2026-09-13' },
    { reminderTime: '25:00' }, { completionDates: ['2026-09-13', '2026-09-13'] },
  ])('rejects invalid data atomically: %j', async invalid => {
    const response = await put(task(invalid));
    expect(response.statusCode).toBe(422);
    expect(store.snapshot().todos).toHaveLength(0);
    expect(store.revision()).toBe(0);
  });
  it('requires distinct strong credentials and refuses implicit timezone changes', () => {
    expect(() => readConfig({ TODO_APP_TOKEN: 'short', TODO_BOT_TOKEN: BOT_TOKEN })).toThrow();
    expect(() => readConfig({ TODO_APP_TOKEN: APP_TOKEN, TODO_BOT_TOKEN: APP_TOKEN })).toThrow();
    const other = join(directory, 'zone.db');
    new Store(other, 'Asia/Shanghai').close();
    expect(() => new Store(other, 'Europe/London')).toThrow(/timezone/);
  });
});

describe('persistence, transactions and migration', () => {
  it('persists definitions, per-day completions and timer entries across restart', async () => {
    const todo = task({ goalStartDate: '2026-09-01', goalEndDate: '2026-10-01', completionDates: ['2026-09-12'], timeEntries: [{ startTime: new Date(now - 65_000).toISOString(), endTime: new Date(now).toISOString(), duration: 65 }], totalTimeSpent: 65 });
    expect((await put(todo)).statusCode).toBe(200);
    await app.close(); store.close();
    store = new Store(config.dbPath, config.timeZone, () => now);
    app = await buildApp(config, { store });
    const saved = store.snapshot().todos[0];
    expect(saved.completionDates).toEqual(['2026-09-12']);
    expect(saved.timeEntries[0].duration).toBe(65);
    expect(saved.timeEntries[0].id).toMatch(/^legacy-/);
    const definition = store.db.prepare('SELECT json FROM todos WHERE id=?').get(todo.id) as { json: string };
    expect(JSON.parse(definition.json)).not.toHaveProperty('completionDates');
    expect(JSON.parse(definition.json)).not.toHaveProperty('timeEntries');
  });
  it('rejects stale concurrent writes but safely replays a lost response', async () => {
    const todo = task(), id = randomUUID();
    expect((await put(todo, 0, id)).statusCode).toBe(200);
    const stale = await put(task(), 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('REVISION_CONFLICT');
    const replay = await put(todo, 0, id);
    expect(replay.json().replayed).toBe(true);
    expect(store.snapshot().todos).toHaveLength(1);
    expect(store.revision()).toBe(1);
    expect((await put({ ...todo, title: 'different' }, 0, id)).json().error).toBe('IDEMPOTENCY_MISMATCH');
  });
  it('updates a list and its tasks in one transaction, preserving default lists', async () => {
    const todo = task();
    await put(todo);
    const payload = { expectedRevision: 1, mutationId: randomUUID(), operations: [{ type: 'todo.put', value: { ...todo, listId: 'custom' } }, { type: 'list.put', value: { id: 'custom', name: 'Work', createdAt: new Date(now).toISOString() } }] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/mutations', headers: headers(), payload })).statusCode).toBe(200);
    expect(store.snapshot().todos[0].listId).toBe('custom');
    const bad = { expectedRevision: 2, mutationId: randomUUID(), operations: [{ type: 'list.delete', id: 'list-inbox' }] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/mutations', headers: headers(), payload: bad })).statusCode).toBe(422);
    expect(store.revision()).toBe(2);
  });
  it('previews/imports only into pristine server; device settings never enter DB', async () => {
    const business = emptyBusiness(); business.todos = [task()];
    const data = backup(business);
    const preview = await app.inject({ method: 'POST', url: '/api/v1/import/preview', headers: headers(), payload: data });
    expect(preview.json()).toMatchObject({ canImport: true, counts: { tasks: 1, lists: 3, diary: 0 } });
    const payload = { expectedRevision: 0, mutationId: randomUUID(), backup: data };
    const imported = await app.inject({ method: 'POST', url: '/api/v1/import', headers: headers(), payload });
    expect(imported.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/import', headers: headers(), payload })).json().replayed).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/import', headers: headers(), payload: { ...payload, expectedRevision: 1, mutationId: randomUUID() } })).json().error).toBe('SERVER_NOT_EMPTY');
    const exported = (await app.inject({ url: '/api/v1/export', headers: headers() })).json();
    expect(exported.business.todos).toHaveLength(1);
    expect(exported).not.toHaveProperty('deviceSettings');
  });
  it('rejects nonmatching backup timezone without shifting historical days', async () => {
    const data = { ...backup(emptyBusiness()), timeZone: 'America/New_York' };
    const result = await app.inject({ method: 'POST', url: '/api/v1/import/preview', headers: headers(), payload: data });
    expect(result.json().error).toBe('TIMEZONE_MISMATCH');
  });
  it('creates consistent online backups including WAL and refuses to overwrite a backup', async () => {
    const todo = task(); await put(todo);
    const destination = join(directory, 'backup.db');
    await backupDatabase(config.dbPath, destination);
    const restored = new Store(destination, config.timeZone, () => now);
    expect(restored.snapshot().todos[0].id).toBe(todo.id);
    restored.close();
    await expect(backupDatabase(config.dbPath, destination)).rejects.toThrow();
  });
});

describe('bot commands and reminders', () => {
  it('creates tasks through bot API, desktop sees them, daily completion is idempotent', async () => {
    const result = await botAction({ action: 'create', task: { title: 'Read', goalStartDate: '2026-09-13', goalEndDate: '2026-09-20', reminderTime: '20:00' } });
    expect(result.statusCode).toBe(200);
    const taskId = result.json().taskId;
    expect(store.snapshot().todos[0].title).toBe('Read');
    for (let i = 0; i < 2; i++) expect((await botAction({ action: 'complete', taskId, completed: true })).statusCode).toBe(200);
    expect(store.snapshot().todos[0].completionDates).toEqual(['2026-09-13']);
    expect((await botAction({ action: 'complete', taskId, completed: true, date: '2026-09-21' })).statusCode).toBe(422);
    await botAction({ action: 'complete', taskId, completed: false });
    expect(store.snapshot().todos[0].completionDates).toEqual([]);
  });
  it('without a binding does not consume attempts; only one worker may claim', async () => {
    await put(task({ reminderAt: new Date(now).toISOString() }));
    expect(store.claim()).toEqual([]);
    bind();
    const jobs = store.claim(); expect(jobs).toHaveLength(1); expect(jobs[0].attempts).toBe(1);
    expect(store.claim()).toEqual([]);
    expect(store.validateLease(jobs[0].id, jobs[0].leaseToken)).toBe(true);
  });
  it('lease expires after restart, and stale ACK cannot settle the new claim', async () => {
    await put(task({ reminderAt: new Date(now).toISOString() })); bind();
    const old = store.claim()[0]; now += 121_000;
    const next = store.claim()[0];
    expect(next.leaseToken).not.toBe(old.leaseToken);
    expect(() => store.settle(old.id, old.leaseToken, '111')).toThrow(/another worker/);
    expect(store.settle(next.id, next.leaseToken, '222')).toEqual({ status: 'sent' });
    expect(store.settle(next.id, next.leaseToken, '222')).toEqual({ status: 'sent' });
    expect(store.claim()).toEqual([]);
  });
  it('failed sends back off without ACK and stop after bounded attempts', async () => {
    await put(task({ reminderAt: new Date(now).toISOString() })); bind();
    for (let i = 1; i <= 8; i++) {
      const job = store.claim()[0]; expect(job.attempts).toBe(i);
      expect(store.settle(job.id, job.leaseToken).status).toBe(i === 8 ? 'failed' : 'pending');
      expect(store.claim()).toEqual([]); now += 3_601_000;
    }
    expect(store.reminderStats().failed).toBe(1);
  });
  it('completion, deletion and rescheduling invalidate old unsent leases', async () => {
    const todo = task({ reminderAt: new Date(now).toISOString() }); await put(todo); bind();
    const first = store.claim()[0];
    await botAction({ action: 'complete', taskId: todo.id, completed: true });
    expect(store.validateLease(first.id, first.leaseToken)).toBe(false);
    expect(store.claim()).toEqual([]);
    await botAction({ action: 'complete', taskId: todo.id, completed: false });
    const second = store.claim()[0];
    await botAction({ action: 'remind', taskId: todo.id, reminderAt: new Date(now + 60_000).toISOString() });
    expect(store.validateLease(second.id, second.leaseToken)).toBe(false);
    expect(store.claim()).toEqual([]); now += 60_000;
    const third = store.claim()[0]; expect(third.id).not.toBe(second.id);
    await app.inject({ method: 'POST', url: '/api/v1/mutations', headers: headers(), payload: { expectedRevision: store.revision(), mutationId: randomUUID(), operations: [{ type: 'todo.delete', id: todo.id }] } });
    expect(store.validateLease(third.id, third.leaseToken)).toBe(false);
  });
  it('sent reminders are not re-created by unrelated edits or reconciliation', async () => {
    const todo = task({ reminderAt: new Date(now).toISOString() }); await put(todo); bind();
    const job = store.claim()[0]; store.settle(job.id, job.leaseToken, '333');
    await put({ ...store.snapshot().todos[0], title: 'Renamed' });
    expect(store.claim()).toEqual([]);
    expect(store.reminderStats().sent).toBe(1);
  });
  it('daily reminders use server local dates, skip completed days, do not flood past days', async () => {
    const todo = task({ goalStartDate: '2026-09-01', goalEndDate: '2026-09-20', reminderTime: '08:00', completionDates: ['2026-09-13'] }); await put(todo); bind();
    expect(store.claim()).toEqual([]);
    now += 24 * 3_600_000;
    const job = store.claim()[0]; expect(job.scheduledAt).toBe('2026-09-14T00:00:00.000Z');
    store.settle(job.id, job.leaseToken, '444');
    now += 3 * 24 * 3_600_000;
    const later = store.claim(); expect(later).toHaveLength(1);
    expect(later[0].scheduledAt).toBe('2026-09-17T00:00:00.000Z');
  });
  it('one-off reminders older than 24 hours are missed rather than spammed', async () => {
    await put(task({ reminderAt: new Date(now - 25 * 3_600_000).toISOString() })); bind();
    expect(store.claim()).toEqual([]); expect(store.reminderStats().missed).toBe(1);
  });
  it('binding changes fence existing workers; unbind stops delivery', async () => {
    await put(task({ reminderAt: new Date(now).toISOString() })); bind();
    const first = store.claim()[0];
    store.bind({ senderId: '100000002', platformId: 'test-qq', session: 'test-qq:FriendMessage:100000002' });
    expect(store.validateLease(first.id, first.leaseToken)).toBe(false);
    expect(store.claim()[0].binding.senderId).toBe('100000002');
    store.unbind(); expect(store.claim()).toEqual([]);
  });
  it('time conversion rejects ambiguous/nonexistent DST wall times and respects Shanghai midnight', () => {
    expect(wallToInstant('2026-09-13T08:00', 'Asia/Shanghai')).toBe('2026-09-13T00:00:00Z');
    expect(dateInZone(Date.parse('2026-09-12T16:01:00Z'), 'Asia/Shanghai')).toBe('2026-09-13');
    expect(() => wallToInstant('2026-03-08T02:30', 'America/New_York')).toThrow();
    expect(() => wallToInstant('2026-11-01T01:30', 'America/New_York')).toThrow();
  });
});

it('ACK requires a nonzero OneBot message ID', async () => {
  await put(task({ reminderAt: new Date(now).toISOString() })); bind();
  const job = store.claim()[0];
  for (const messageId of ['0', '-0', '000']) {
    const response = await app.inject({ method: 'POST', url: `/api/v1/bot/reminders/${job.id}/ack`, headers: headers(true), payload: { leaseToken: job.leaseToken, messageId } });
    expect(response.statusCode).toBe(422);
  }
  expect(store.reminderStats().sent ?? 0).toBe(0);
});
it('only one reminder mode can be set, and changing mode clears the other', async () => {
  const todo = task({ goalStartDate: '2026-09-13', goalEndDate: '2026-10-13', reminderTime: '20:30' });
  await put(todo);
  expect((await put({ ...todo, reminderAt: new Date(now).toISOString() })).statusCode).toBe(422);
  expect((await botAction({ action: 'remind', taskId: todo.id, reminderTime: '20:00', reminderAt: new Date(now).toISOString() })).statusCode).toBe(422);
  expect((await botAction({ action: 'remind', taskId: todo.id, reminderAt: new Date(now).toISOString() })).statusCode).toBe(200);
  expect(store.snapshot().todos[0].reminderTime).toBeUndefined();
  expect((await botAction({ action: 'remind', taskId: todo.id, reminderTime: '21:00' })).statusCode).toBe(200);
  expect(store.snapshot().todos[0].reminderAt).toBeUndefined();
});

describe('recycle bin persistence and reminder safety', () => {
  it('hides trashed tasks from bot queries/actions and cancels even an already leased reminder', async () => {
    const goal = task({ goalStartDate: '2026-09-12', goalEndDate: '2026-09-30', reminderTime: '07:59', completionDates: ['2026-09-12'] });
    expect((await put(goal)).statusCode).toBe(200);
    bind();
    const [leased] = store.claim();
    expect(leased.todoId).toBe(goal.id);
    expect((await put(trashTodo([goal], goal.id, new Date(now).toISOString(), randomUUID())[0])).statusCode).toBe(200);
    expect(store.validateLease(leased.id, leased.leaseToken)).toBe(false);
    expect(store.claim()).toEqual([]);
    expect((await app.inject({ url: '/api/v1/bot/tasks', headers: headers(true) })).json().tasks).toEqual([]);
    const revision = store.revision();
    expect((await botAction({ action: 'complete', taskId: goal.id, completed: true })).statusCode).toBe(404);
    expect((await botAction({ action: 'remind', taskId: goal.id, reminderTime: '09:00' })).statusCode).toBe(404);
    expect(store.revision()).toBe(revision);
    expect((await app.inject({ method: 'POST', url: `/api/v1/bot/reminders/${leased.id}/ack`, headers: headers(true), payload: { leaseToken: leased.leaseToken, messageId: '123456789' } })).statusCode).toBe(409);
    const recovered = restoreTodo(store.snapshot().todos, goal.id, new Date(now).toISOString())[0];
    expect((await put(recovered)).statusCode).toBe(200);
    expect(store.claim()).toEqual([]); // recovery is not a request to replay an old reminder
    expect(store.snapshot().todos[0].completionDates).toEqual(['2026-09-12']);
    expect((await app.inject({ url: '/api/v1/bot/tasks', headers: headers(true) })).json().tasks).toHaveLength(1);
    await put({ ...recovered, reminderTime: '08:01' });
    now += 61_000;
    expect(store.claim()).toHaveLength(1); // deliberately setting a new reminder works
  });

  it('retains tombstones, completion history and time in JSON export and a verified SQLite backup', async () => {
    const goal = task({ goalStartDate: '2026-09-10', goalEndDate: '2026-09-30', completionDates: ['2026-09-12'],
      completionNotes: 'Synthetic history', timeEntries: [{ id: 'synthetic-timer', startTime: new Date(now).toISOString(), duration: 300 }], totalTimeSpent: 300 });
    const deleted = trashTodo([goal], goal.id, new Date(now).toISOString(), randomUUID())[0];
    expect((await put(deleted)).statusCode).toBe(200);
    const exported = backupSchema.parse((await app.inject({ url: '/api/v1/export', headers: headers() })).json());
    expect(exported.business.todos).toEqual([deleted]);
    const path = join(directory, 'recycle-backup.db');
    await backupDatabase(config.dbPath, path);
    const restored = new Store(path, config.timeZone, () => now);
    try {
      expect(restored.snapshot().todos).toEqual([deleted]);
      expect(restored.snapshot().revision).toBe(store.revision());
    } finally { restored.close(); }
    await app.close(); store.close();
    store = new Store(config.dbPath, config.timeZone, () => now);
    app = await buildApp(config, { store });
    expect((await app.inject({ url: '/api/v1/state', headers: headers() })).json().todos).toEqual([deleted]);
  });
});
